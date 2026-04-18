// Refactored by builder-5 (gemma4:31b)
/**
 * Callback Dispatch Service
 * Use case: handling all callback query and message events from Telegram
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'path';
import type { Api } from 'grammy';
import pino from 'pino';
import type { BackendClient } from '../clients/api/backend-client.ts';
import type { MiniMaxClient } from '../clients/llm/minimax-client.ts';
import {
  buildCancelSearchKeyboard,
  buildImageChoiceButtons,
  buildOnlyOriginalSelection,
  buildPublishNoFeedback,
  buildReviewButtons,
  buildRewriteKeyboard,
  buildRewriteNoFeedbackKeyboard,
  CALLBACK_ACTION,
} from '../shared/callback-actions.ts';
import { FLAGS, NEUROVANYA_BOT_TOKEN } from '../shared/config.ts';
import { buildPublishKeyboard } from '../shared/keyboards.ts';
import type { PostForReview } from '../shared/backend-types.ts';
import type { CallbackContext, TelegramUpdate } from '../shared/telegram-types.ts';
import type { PostImage, PostWithDetails } from '../shared/types.ts';
import { escapeHtml } from '../shared/utils/escape-html.ts';
import { buildTelegramPostUrl } from '../shared/utils/telegram-urls.ts';
import { fileExists } from '../shared/utils/file-exists.ts';
import { parseCallbackData } from '../shared/utils/callback-parser.ts';
import {
  formatPostTextWithSource,
  formatPostTextWithoutSource,
} from '../shared/utils/post-formatters.ts';
import {
  createImageSearchOrchestrator,
  type ImageSearchOrchestrator,
} from './image-search-orchestrator.ts';
import { PublishDispatchService } from './publish-dispatch-service.ts';
import type {
  PendingOperation,
  PendingState,
  PendingStateService,
} from './pending-state-service.ts';
import { createPendingStateService } from './pending-state-service.ts';
import { createRewriteService, type RewriteService } from './rewrite-service.ts';
import { TelegramMessageService } from './telegram-message-service.ts';

const MEMORY_IMAGES_DIR = './memory/images';
const REWRITE_CALLBACK_PROMPT_PATH = './src/assets/rewrite-system.txt';
const REWRITE_PUBLISH_PROMPT_PATH = './src/assets/rewrite-publish-system.txt';
const REWRITE_PUBLISH_WITH_FEEDBACK_PROMPT_PATH =
  './src/assets/rewrite-publish-feedback-system.txt';

const logger = pino({
  level: FLAGS.VERBOSE ? 'debug' : 'info',
});

type TelegramMessage = NonNullable<TelegramUpdate['message']>;
type TelegramCallbackQuery = NonNullable<TelegramUpdate['callback_query']>;

interface ImageState {
  foundImages: PostImage[];
  originalImage?: PostImage;
  originalLocalPath?: string;
  hasOriginalLocal: boolean;
}

/**
 * CallbackDispatchService handles all Telegram callback and message events.
 */
export class CallbackDispatchService {
  private readonly backend: BackendClient;
  private readonly telegram: Api;
  private readonly llm: MiniMaxClient;
  private readonly rewriteCallbackPrompt: string;
  private readonly rewritePublishPrompt: string;
  private readonly rewritePublishWithFeedbackPrompt: string;

  private readonly pendingStateService: PendingStateService;
  private readonly rewriteService: RewriteService;
  private readonly imageSearchOrchestrator: ImageSearchOrchestrator | null;
  private readonly telegramService: TelegramMessageService;

  private constructor(
    backend: BackendClient,
    telegram: Api,
    llm: MiniMaxClient,
    rewriteCallbackPrompt: string,
    rewritePublishPrompt: string,
    rewritePublishWithFeedbackPrompt: string
  ) {
    this.backend = backend;
    this.telegram = telegram;
    this.llm = llm;
    this.rewriteCallbackPrompt = rewriteCallbackPrompt;
    this.rewritePublishPrompt = rewritePublishPrompt;
    this.rewritePublishWithFeedbackPrompt = rewritePublishWithFeedbackPrompt;

    this.pendingStateService = createPendingStateService();
    this.rewriteService = createRewriteService({ llm: this.llm });
    this.imageSearchOrchestrator = createImageSearchOrchestrator({ backend });
    this.telegramService = new TelegramMessageService(this.telegram);

    if (!this.imageSearchOrchestrator) {
      logger.warn('ImageSearchOrchestrator not initialized - TAVILY_API_KEY may be missing');
    }
  }

  static async create(
    backend: BackendClient,
    telegram: Api,
    llm: MiniMaxClient
  ): Promise<CallbackDispatchService> {
    const [rewriteCallbackPrompt, rewritePublishPrompt, rewritePublishWithFeedbackPrompt] =
      await Promise.all([
        readFile(REWRITE_CALLBACK_PROMPT_PATH, 'utf-8').then((s) => s.trim()),
        readFile(REWRITE_PUBLISH_PROMPT_PATH, 'utf-8').then((s) => s.trim()),
        readFile(REWRITE_PUBLISH_WITH_FEEDBACK_PROMPT_PATH, 'utf-8').then((s) => s.trim()),
      ]);

    return new CallbackDispatchService(
      backend,
      telegram,
      llm,
      rewriteCallbackPrompt,
      rewritePublishPrompt,
      rewritePublishWithFeedbackPrompt
    );
  }

  /**
   * Process a single Telegram update (callback query or message)
   */
  async processUpdate(update: TelegramUpdate): Promise<void> {
    logger.debug({ updateId: update.update_id }, 'received update');

    if (update.message) {
      await this.handleMessage(update.message);
      return;
    }

    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  private async handleCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const { data, message, id: callbackId } = callbackQuery;

    if (!data || !message) {
      logger.debug(
        { callbackId, hasData: !!data, hasMessage: !!message },
        'skip incomplete callback query'
      );
      return;
    }

    const callbackMessage = message as { chat: { id: number }; message_id: number };
    const parsed = parseCallbackData(data);

    const context: CallbackContext = {
      callbackId,
      action: parsed.action,
      chatId: String(callbackMessage.chat.id),
      messageId: callbackMessage.message_id,
      postId: parsed.postId,
      imageId: parsed.imageId,
    };

    logger.debug({ callbackId, action: context.action }, 'routing callback');

    const handler = this.actionHandlers[context.action];
    if (handler) {
      await handler(context);
    } else {
      await this.telegramService.answerCallbackQuery(callbackId, { text: 'Unknown action' });
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const pending = this.pendingStateService.getPending(chatId);

    if (!pending) return;

    if (message.photo && pending.operation === 'upload_image') {
      this.pendingStateService.clearPending(chatId);
      await this.handlePhotoMessage(chatId, message.photo, pending.postId);
      return;
    }

    const text = message.text?.trim();
    if (!text) return;

    this.pendingStateService.clearPending(chatId);

    switch (pending.operation) {
      case 'rewrite_feedback':
        await this.doRewrite(pending.postId, chatId, text);
        break;
      case 'rewrite_publish_feedback':
        await this.doRewritePublish(pending.postId, chatId, text);
        break;
      case 'image_search':
        await this.doSearchImages(pending.postId, chatId, text);
        break;
    }
  }

  private readonly actionHandlers: Record<string, (ctx: CallbackContext) => Promise<void>> = {
    [CALLBACK_ACTION.APPROVE]: (ctx) => this.handleApproveOrReject(ctx),
    [CALLBACK_ACTION.REJECT]: (ctx) => this.handleApproveOrReject(ctx),
    [CALLBACK_ACTION.REWRITE]: (ctx) => this.handleRewriteAction(ctx),
    [CALLBACK_ACTION.REWRITE_NOW]: (ctx) => this.handleRewriteNow(ctx),
    [CALLBACK_ACTION.SELECT]: (ctx) => this.handleSelect(ctx),
    [CALLBACK_ACTION.PUBLISHED]: (ctx) => this.handlePublishedAction(ctx),
    [CALLBACK_ACTION.REWRITE_PUBLISH]: (ctx) => this.handleRewritePublishAction(ctx),
    [CALLBACK_ACTION.REWRITE_PUBLISH_NOW]: (ctx) => this.handleRewritePublishNow(ctx),
    [CALLBACK_ACTION.UPLOAD_IMAGE]: (ctx) => this.handleUploadImageAction(ctx),
    [CALLBACK_ACTION.SEARCH_IMAGES]: (ctx) => this.handleSearchImagesAction(ctx),
    [CALLBACK_ACTION.PUBLISH_WITHOUT_IMAGE]: (ctx) => this.handlePublishWithoutImageAction(ctx),
    [CALLBACK_ACTION.CANCEL_SEARCH]: (ctx) => this.handleCancelSearch(ctx),
    [CALLBACK_ACTION.BACK_TO_REWRITE]: (ctx) => this.handleBackToRewriteAction(ctx),
    [CALLBACK_ACTION.RESET_FROM_REWRITE]: (ctx) => this.handleResetFromRewrite(ctx),
    [CALLBACK_ACTION.SELECT_IMAGES]: (ctx) => this.handleSelectImagesAction(ctx),
    [CALLBACK_ACTION.RESET]: (ctx) => this.handleResetAction(ctx),
  };

  private async handleApproveOrReject(ctx: CallbackContext): Promise<void> {
    if (!ctx.postId) {
      await this.telegramService.answerCallbackQuery(ctx.callbackId, {
        text: '❌ Error: postId not specified',
      });
      return;
    }
    await this.handleReviewAction(
      ctx.postId,
      ctx.action as 'approve' | 'reject',
      ctx.callbackId,
      ctx.chatId,
      ctx.messageId
    );
  }

  private async handleRewriteAction(ctx: CallbackContext): Promise<void> {
    if (ctx.postId) await this.handleRewrite(ctx.postId, ctx.callbackId, ctx.chatId);
  }

  private async handleRewriteNow(ctx: CallbackContext): Promise<void> {
    if (!ctx.postId) return;
    this.pendingStateService.clearPending(ctx.chatId, 'rewrite_feedback');
    await this.telegramService.answerCallbackQuery(ctx.callbackId, { text: '🔄 Rewriting...' });
    await this.doRewrite(ctx.postId, ctx.chatId, undefined);
  }

  private async handleSelect(ctx: CallbackContext): Promise<void> {
    if (ctx.postId && ctx.imageId !== undefined) {
      await this.handleSelectImage(
        ctx.postId,
        ctx.imageId,
        ctx.callbackId,
        ctx.chatId,
        ctx.messageId
      );
    }
  }

  private async handlePublishedAction(ctx: CallbackContext): Promise<void> {
    if (ctx.postId)
      await this.handlePublished(ctx.postId, ctx.callbackId, ctx.chatId, ctx.messageId);
  }

  private async handleRewritePublishAction(ctx: CallbackContext): Promise<void> {
    if (ctx.postId)
      await this.handleRewritePublish(ctx.postId, ctx.callbackId, ctx.chatId, ctx.messageId);
  }

  private async handleRewritePublishNow(ctx: CallbackContext): Promise<void> {
    if (!ctx.postId) return;
    this.pendingStateService.clearPending(ctx.chatId, 'rewrite_publish_feedback');
    await this.telegramService.answerCallbackQuery(ctx.callbackId, { text: '🔄 Rewriting...' });
    await this.doRewritePublish(ctx.postId, ctx.chatId, undefined);
  }

  private async handleUploadImageAction(ctx: CallbackContext): Promise<void> {
    if (ctx.postId) await this.handleUploadImage(ctx.postId, ctx.callbackId, ctx.chatId);
  }

  private async handleSearchImagesAction(ctx: CallbackContext): Promise<void> {
    if (ctx.postId) await this.handleSearchImages(ctx.postId, ctx.callbackId, ctx.chatId);
  }

  private async handlePublishWithoutImageAction(ctx: CallbackContext): Promise<void> {
    if (ctx.postId)
      await this.handlePublishWithoutImage(ctx.postId, ctx.callbackId, ctx.chatId, ctx.messageId);
  }

  private async handleCancelSearch(ctx: CallbackContext): Promise<void> {
    this.pendingStateService.clearPending(ctx.chatId, 'image_search');
    await this.telegramService.answerCallbackQuery(ctx.callbackId, { text: 'Cancelled' });
  }

  private async handleBackToRewriteAction(ctx: CallbackContext): Promise<void> {
    if (ctx.postId) await this.handleBackToRewrite(ctx.postId, ctx.callbackId, ctx.chatId);
  }

  private async handleResetFromRewrite(ctx: CallbackContext): Promise<void> {
    if (!ctx.postId) return;
    await this.telegramService.answerCallbackQuery(ctx.callbackId, { text: '🔄 Regenerating...' });
    await this.doRewrite(ctx.postId, ctx.chatId, undefined, false);
  }

  private async handleSelectImagesAction(ctx: CallbackContext): Promise<void> {
    if (ctx.postId) await this.handleSelectImages(ctx.postId, ctx.callbackId, ctx.chatId);
  }

  private async handleResetAction(ctx: CallbackContext): Promise<void> {
    if (ctx.postId)
      await this.handleResetToReview(ctx.postId, ctx.callbackId, ctx.chatId, ctx.messageId);
  }

  // ── Rewrite handlers ───────────────────────────────────────────────

  private async handleRewrite(postId: number, callbackId: string, chatId: string): Promise<void> {
    await this.telegramService.answerCallbackQuery(callbackId, { text: '✏️ Write what's wrong' });
    this.pendingStateService.setPending(chatId, { postId, operation: 'rewrite_feedback' });

    const keyboard = buildRewriteNoFeedbackKeyboard(postId);
    await this.telegramService.sendMessage(
      chatId,
      `✏️ Write what's wrong with post #${postId} text (or press "No comment"):`,
      { reply_markup: keyboard }
    );
  }

  private async doRewrite(
    postId: number,
    chatId: string,
    feedback: string | undefined,
    usePrevSummary = true
  ): Promise<void> {
    try {
      const post = await this.backend.getPost(postId);
      const text = post?.original_text || '';

      const rewriteResult = await this.rewriteService.rewriteForCallback(
        {
          text,
          channelId: post?.channel_telegram_id || String(post?.channel_id || ''),
          prevSummary: usePrevSummary ? (post?.summary ?? undefined) : undefined,
          userFeedback: feedback,
        },
        this.rewriteCallbackPrompt,
        usePrevSummary
      );

      if (!rewriteResult.success || !rewriteResult.summary) {
        await this.telegramService.sendMessage(
          chatId,
          `❌ ${rewriteResult.error || 'MiniMax returned empty response'} for post #${postId}. Try "Rewrite" again.`
        );
        return;
      }

      const summary = rewriteResult.summary;
      await this.backend.generateSummary(postId, summary);

      const telegramMessageId =
        typeof post?.telegram_msg_id === 'number' ? post.telegram_msg_id : undefined;
      const newText = formatPostTextWithSource(
        post?.channel_name || '',
        summary,
        post?.channel_telegram_id || String(post?.channel_id || ''),
        telegramMessageId
      );

      const keyboard = buildRewriteKeyboard(postId);
      await this.telegramService.sendMessage(chatId, newText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (err: unknown) {
      logger.error({ postId, chatId, err }, 'rewrite callback failed');
      await this.telegramService.sendMessage(
        chatId,
        `❌ Error rewriting post #${postId}`
      );
    }
  }

  // ── Review handlers ────────────────────────────────────────────────

  private async finalizeStatusMessage(
    callbackId: string,
    chatId: string,
    messageId: number,
    statusLabel: string,
    summary?: string
  ): Promise<void> {
    try {
      await this.telegramService.answerCallbackQuery(callbackId, { text: statusLabel });
    } catch (err) {
      logger.error({ callbackId, err }, 'answerCallbackQuery failed');
    }

    try {
      await this.telegramService.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      logger.error({ chatId, messageId, err }, 'editMessageReplyMarkup failed');
    }

    const text = summary
      ? `<b>${escapeHtml(statusLabel)}</b>\n\n${escapeHtml(summary)}`
      : `<b>${escapeHtml(statusLabel)}</b>`;
    try {
      await this.telegramService.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error({ chatId, messageId, err }, 'editMessageText failed');
    }
  }

  private async handleReviewAction(
    postId: number,
    action: 'approve' | 'reject',
    callbackId: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    try {
      await this.backend.reviewPost(postId, action);
      const label = action === 'approve' ? '✅ Approved' : '❌ Rejected';

      const post =
        action === 'approve' ? await this.backend.getPost(postId).catch(() => null) : null;
      await this.finalizeStatusMessage(
        callbackId,
        chatId,
        messageId,
        label,
        post?.summary ?? undefined
      );

      if (action === 'approve') {
        if (post) {
          await this.sendPostForPublish(post, chatId);
        } else {
          await this.telegramService.sendMessage(
            chatId,
            `❌ Post #${postId} approved, but failed to prepare for publishing.`
          );
        }
      } else {
        await this.sendNextForReview(chatId);
      }
    } catch (err) {
      logger.error({ postId, action, chatId, messageId, err }, 'review action failed');
      await this.telegramService.answerCallbackQuery(callbackId, { text: 'Error' });
    }
  }

  private async sendNextForReview(chatId: string): Promise<void> {
    try {
      const result = await this.backend.getNextForReview({ ignoreCooldown: true });
      if (result) await this.sendReviewPost(chatId, result.post);
    } catch (err) {
      logger.error({ chatId, err }, 'failed to send next review post');
    }
  }

  private async sendReviewPost(
    chatId: string,
    post: PostWithDetails | PostForReview
  ): Promise<void> {
    const channelTelegramId =
      'channel_telegram_id' in post ? post.channel_telegram_id : post.channel_id;
    const channelSlug = (channelTelegramId || '').toString().replace('@', '');
    const origUrl =
      channelSlug && post.telegram_msg_id
        ? `\n\n<a href="${buildTelegramPostUrl(channelSlug, post.telegram_msg_id)}">Source</a>`
        : '';
    const text = `<b>${escapeHtml(post.channel_name || '')}</b>\n\n${escapeHtml(post.summary || '')}${origUrl}`;

    const images = post.images ?? [];
    const originalImage = images.find((i) => i.image_type === 'original');
    const hasLocalPath = !!(
      originalImage?.local_path && (await fileExists(originalImage.local_path))
    );
    const replyMarkup = buildReviewButtons(
      post.id,
      hasLocalPath && originalImage ? originalImage.id : undefined
    );

    await this.backend.updatePost(post.id, { user_feedback: 'review_sending' });

    try {
      if (hasLocalPath && originalImage?.local_path) {
        await this.telegramService.sendPhoto(chatId, originalImage.local_path, {
          caption: text,
          parse_mode: 'HTML',
        });
        await this.telegramService.sendMessage(
          chatId,
          `📋 Post #${post.id} sent for review.`,
          { reply_markup: replyMarkup }
        );
      } else {
        await this.telegramService.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        });
      }
      await this.backend.updatePost(post.id, { user_feedback: 'review_sent' });
    } catch (tgErr) {
      await this.backend.updatePost(post.id, { user_feedback: null });
      throw tgErr;
    }
  }

  private async sendPostForPublish(post: PostWithDetails, chatId: string): Promise<void> {
    const service = new PublishDispatchService(this.backend, this.telegram);
    const result = await service.dispatch({ post, chatId });

    if (!result.success) {
      logger.error({ postId: post.id, chatId, error: result.error }, 'publish dispatch failed');
      await this.telegramService.sendMessage(
        chatId,
        `❌ Failed to send post #${post.id} for publishing: ${result.error || 'unknown error'}`
      );
    }
  }

  // ── Image selection handlers ───────────────────────────────────────

  private async handleSelectImage(
    postId: number,
    imageId: number,
    callbackId: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    try {
      await this.backend.selectImage(postId, imageId);
      await this.telegramService.answerCallbackQuery(callbackId, { text: '🖼️ Image selected' });
      await this.telegramService.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: { inline_keyboard: [] },
      });
      await this.telegramService.editMessageText(
        chatId,
        messageId,
        `<b>✅ Image selected</b> (image_id=${imageId})`,
        { parse_mode: 'HTML' }
      );

      const freshPost = await this.backend.getPost(postId);
      if (freshPost) await this.sendPostForPublish(freshPost, chatId);
    } catch (err) {
      logger.error({ postId, imageId, chatId, messageId, err }, 'image selection failed');
      await this.telegramService.answerCallbackQuery(callbackId, { text: 'Error' });
    }
  }

  private async handlePublished(
    postId: number,
    callbackId: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    try {
      await this.backend.markPublished(postId);
      const post = await this.backend.getPost(postId);
      await this.finalizeStatusMessage(
        callbackId,
        chatId,
        messageId,
        '✅ Published',
        post?.summary || ''
      );
      await this.sendNextForReview(chatId);
    } catch (err) {
      logger.error({ postId, chatId, messageId, err }, 'mark published failed');
      await this.telegramService.answerCallbackQuery(callbackId, { text: 'Error' });
    }
  }

  // ── Upload handlers ───────────────────────────────────────────────

  private async handleUploadImage(
    postId: number,
    callbackId: string,
    chatId: string
  ): Promise<void> {
    this.pendingStateService.setPending(chatId, { postId, operation: 'upload_image' });
    await this.telegramService.answerCallbackQuery(callbackId, { text: '📷 Send an image' });
    await this.telegramService.sendMessage(
      chatId,
      `📷 Send an image for post #${postId} as the next message.`
    );
  }

  private async handlePhotoMessage(
    chatId: string,
    photoSizes: Array<{ file_id: string }>,
    postId: number
  ): Promise<void> {
    try {
      const fileId = photoSizes[photoSizes.length - 1].file_id;
      const fileResult = await this.telegram.getFile(fileId);
      const filePath = fileResult.file_path;
      if (!filePath || !NEUROVANYA_BOT_TOKEN) return;

      const fileUrl = `https://api.telegram.org/file/bot${NEUROVANYA_BOT_TOKEN}/${filePath}`;
      const ext = (filePath.match(/\.(jpg|jpeg|png|webp)$/i) || [])[1] || 'jpg';
      const filename = `post${postId}_user_upload.${ext}`;

      await this.backend.downloadImage(fileUrl, filename);
      await this.backend.saveImages(postId, [
        {
          url: fileUrl,
          source: 'user_upload',
          local_path: resolve(MEMORY_IMAGES_DIR, filename),
        },
      ]);

      const post = await this.backend.getPost(postId);
      const userImage = post?.images?.find(
        (i) => i.type === 'found_1' || i.source === 'user_upload'
      );
      if (userImage) await this.backend.selectImage(postId, userImage.id as number);

      await this.telegramService.sendMessage(chatId, `✅ Image saved for post #${postId}`);

      const freshPost = await this.backend.getPost(postId);
      if (freshPost) await this.sendPostForPublish(freshPost, chatId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ postId, chatId, err }, 'user image upload failed');
      await this.telegramService.sendMessage(chatId, `❌ Error saving image: ${msg}`);
    }
  }

  // ── Rewrite publish handlers ─────────────────────────────────────

  private async handleRewritePublish(
    postId: number,
    callbackId: string,
    chatId: string,
    _messageId: number
  ): Promise<void> {
    this.pendingStateService.setPending(chatId, { postId, operation: 'rewrite_publish_feedback' });
    await this.telegramService.answerCallbackQuery(callbackId, {
      text: '✏️ Write what to fix',
    });
    const keyboard = buildPublishNoFeedback(postId);
    await this.telegramService.sendMessage(
      chatId,
      `✏️ Write what to fix in post #${postId} (or press "No comment"):`,
      { reply_markup: keyboard }
    );
  }

  private async doRewritePublish(
    postId: number,
    chatId: string,
    feedback: string | undefined
  ): Promise<void> {
    try {
      const post = await this.backend.getPost(postId);
      const text = post?.original_text || '';
      const systemPrompt = feedback
        ? this.rewritePublishWithFeedbackPrompt
        : this.rewritePublishPrompt;

      const rewriteResult = await this.rewriteService.rewriteForPublish(
        {
          text,
          channelId: post?.channel_telegram_id || String(post?.channel_id || ''),
          prevSummary: post?.summary || undefined,
          userFeedback: feedback,
        },
        systemPrompt
      );

      if (!rewriteResult.success || !rewriteResult.summary) {
        await this.telegramService.sendMessage(
          chatId,
          `❌ ${rewriteResult.error || 'MiniMax returned empty response'} for post #${postId}. Try "Rewrite" again.`
        );
        return;
      }

      const summary = rewriteResult.summary;
      await this.backend.generateSummary(postId, summary);

      const newText = formatPostTextWithoutSource(post?.channel_name || '', summary);
      const freshPost = await this.backend.getPost(postId);
      const selectedImg = freshPost?.images?.find((i) => i.id === freshPost.selected_image_id);
      const selectedPath = selectedImg?.local_path;

      if (selectedPath && (await fileExists(selectedPath))) {
        await this.telegramService.sendPhoto(chatId, selectedPath, {
          caption: newText,
          parse_mode: 'HTML',
        });
      } else {
        await this.telegramService.sendMessage(chatId, newText, { parse_mode: 'HTML' });
      }

      const keyboard = buildPublishKeyboard(postId);
      await this.telegramService.sendMessage(
        chatId,
        `📋 Post #${postId} rewritten. Press "Published" when you forward it to the channel.`,
        { reply_markup: keyboard }
      );
    } catch (err) {
      logger.error({ postId, chatId, err }, 'publish rewrite failed');
      await this.telegramService.sendMessage(
        chatId,
        `❌ Error rewriting post #${postId}`
      );
    }
  }

  // ── Image search handlers ─────────────────────────────────────────

  private async handleSearchImages(
    postId: number,
    callbackId: string,
    chatId: string
  ): Promise<void> {
    this.pendingStateService.setPending(chatId, { postId, operation: 'image_search' });
    await this.telegramService.answerCallbackQuery(callbackId, {
      text: '🔍 Enter a search query',
    });
    const keyboard = buildCancelSearchKeyboard(postId);
    await this.telegramService.sendMessage(
      chatId,
      `🔍 Enter a search query for post #${postId}:`,
      { reply_markup: keyboard }
    );
  }

  private async doSearchImages(postId: number, chatId: string, query: string): Promise<void> {
    if (!this.imageSearchOrchestrator) {
      await this.telegramService.sendMessage(chatId, '❌ Tavily API key not configured');
      return;
    }

    const normalizedQuery = query.trim().replace(/\s+/g, ' ').slice(0, 400);
    if (!normalizedQuery) {
      await this.telegramService.sendMessage(chatId, '❌ Search query is empty');
      return;
    }

    try {
      const result = await this.imageSearchOrchestrator.searchImagesForPost(
        postId,
        normalizedQuery
      );

      if (!result.success) {
        if (result.error === 'no_pages_found') {
          const state = await this.imageSearchOrchestrator.getImageState(postId);
          await this.sendNoSearchResults(
            chatId,
            postId,
            normalizedQuery,
            state.hasOriginalLocal,
            state.originalImage?.id
          );
        } else {
          const msg =
            result.error === 'no_images_found'
              ? `😕 No images found for query: ${normalizedQuery}`
              : result.error === 'no_valid_images'
                ? '😕 Could not find valid images in 6 attempts'
                : `❌ Search error: ${result.error}`;
          if (result.error !== 'no_images_found' && result.error !== 'no_valid_images') {
            logger.error(
              { postId, chatId, query: normalizedQuery, error: result.error },
              'image search failed'
            );
          }
          await this.telegramService.sendMessage(chatId, msg);
        }
        return;
      }

      if (result.imageState) await this.sendImageSelection(chatId, postId, result.imageState);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ postId, chatId, query: normalizedQuery, err }, 'image search error');
      await this.telegramService.sendMessage(chatId, `❌ Search error: ${msg}`);
    }
  }

  // ── Other handlers ────────────────────────────────────────────────

  private async handlePublishWithoutImage(
    postId: number,
    callbackId: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    try {
      await this.backend.updatePost(postId, { status: 'ready_publish', selected_image_id: null });
      await this.telegramService.answerCallbackQuery(callbackId, { text: '📸 Sending...' });
      await this.telegramService.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: { inline_keyboard: [] },
      });
      await this.telegramService.editMessageText(chatId, messageId, '<b>📸 Without image</b>', {
        parse_mode: 'HTML',
      });

      const post = await this.backend.getPost(postId);
      if (post) await this.sendPostForPublish(post, chatId);
    } catch (err) {
      logger.error({ postId, chatId, messageId, err }, 'publish without image failed');
      await this.telegramService.answerCallbackQuery(callbackId, { text: 'Error' });
    }
  }

  private async handleBackToRewrite(
    postId: number,
    callbackId: string,
    chatId: string
  ): Promise<void> {
    await this.telegramService.answerCallbackQuery(callbackId, { text: '◀️ Going back' });
    const post = await this.backend.getPost(postId);
    if (!post) {
      await this.telegramService.sendMessage(chatId, `⚠️ Post #${postId} not found`);
      return;
    }

    const channelSlug = (post.channel_telegram_id || post.channel_id || '')
      .toString()
      .replace('@', '');
    const origUrl =
      channelSlug && post.telegram_msg_id
        ? `\n\n<a href="${buildTelegramPostUrl(channelSlug, post.telegram_msg_id as string)}">Source</a>`
        : '';
    const text = `<b>${escapeHtml(post.channel_name || '')}</b>\n\n${escapeHtml(post.summary || '')}${origUrl}`;

    await this.telegramService.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: buildRewriteKeyboard(postId),
    });
  }

  private async handleSelectImages(
    postId: number,
    callbackId: string,
    chatId: string
  ): Promise<void> {
    await this.telegramService.answerCallbackQuery(callbackId, { text: '🖼️ Loading options...' });
    const state = await this.getImageState(postId);

    if (state.foundImages.length === 0) {
      await this.telegramService.sendMessage(chatId, `❌ No images found for post #${postId}`);
      return;
    }

    await this.sendImageSelection(chatId, postId, state);
  }

  private async getImageState(postId: number): Promise<ImageState> {
    const post = await this.backend.getPost(postId);
    const images = post?.images || [];
    const foundImages = images.filter((i) =>
      (i.type || i.image_type || '').toString().startsWith('found_')
    );
    const originalImage = images.find((i) => (i.type || i.image_type) === 'original');
    const originalLocalPath = originalImage?.local ?? originalImage?.local_path ?? undefined;
    const hasOriginalLocal = !!(originalLocalPath && (await fileExists(originalLocalPath)));

    return { foundImages, originalImage, originalLocalPath, hasOriginalLocal };
  }

  private async sendImageSelection(
    chatId: string,
    postId: number,
    state: ImageState
  ): Promise<void> {
    await this.sendImageMediaGroup(chatId, postId, state);
    const replyMarkup = buildImageChoiceButtons(
      postId,
      state.foundImages.map((i) => i.id as number),
      state.originalImage?.id
    );
    await this.telegramService.sendMessage(chatId, `Select an image for post #${postId}:`, {
      reply_markup: replyMarkup,
    });
  }

  private async sendImageMediaGroup(
    chatId: string,
    postId: number,
    state: ImageState
  ): Promise<void> {
    const downloadable = (
      await Promise.all(
        state.foundImages.map(async (img) => {
          if (!img.local_path || !(await fileExists(img.local_path))) return null;
          return img;
        })
      )
    ).filter((img): img is PostImage & { local_path: string } => img !== null);

    if (downloadable.length === 0) return;

    const mediaItems = downloadable.map((img, idx) => ({
      type: 'photo' as const,
      media: img.local_path,
      caption: idx === 0 ? `Image options for post #${postId}` : undefined,
    }));

    if (state.hasOriginalLocal && state.originalLocalPath) {
      mediaItems.unshift({
        type: 'photo' as const,
        media: state.originalLocalPath,
        caption: '🖼️ Original',
      });
    }

    try {
      await this.telegramService.sendMediaGroup(chatId, mediaItems);
    } catch (err) {
      logger.debug({ postId, chatId, err }, 'failed to send media group');
    }
  }

  private async sendNoSearchResults(
    chatId: string,
    postId: number,
    query: string,
    hasOriginalLocal: boolean,
    originalImageId?: number
  ): Promise<void> {
    const text = hasOriginalLocal
      ? `😕 Nothing found for query: ${query}\n🖼️ You can select the original.`
      : `😕 Nothing found for query: ${query}`;
    await this.telegramService.sendMessage(chatId, text);

    if (hasOriginalLocal && originalImageId !== undefined) {
      await this.telegramService.sendMessage(chatId, `Select an image for post #${postId}:`, {
        reply_markup: buildOnlyOriginalSelection(postId, originalImageId),
      });
    }
  }

  private async handleResetToReview(
    postId: number,
    callbackId: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    try {
      await this.backend.resetPost(postId);
      const post = await this.backend.getPost(postId);
      await this.finalizeStatusMessage(
        callbackId,
        chatId,
        messageId,
        '🔄 Returned for revision',
        post?.summary || ''
      );
    } catch (err) {
      logger.error({ postId, chatId, messageId, err }, 'reset to review failed');
      await this.telegramService.answerCallbackQuery(callbackId, { text: 'Error' });
    }
  }
}
