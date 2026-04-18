// Refactored by builder-6 (MiniMax-M2.7)

/**
 * Callback Dispatch Service
 * Use case: handling all callback query and message events from Telegram
 * Responsible for:
 * - routing callback data to corresponding handler methods
 * - pending state management (uploads, rewrite feedback, image search)
 * - all callback action handlers (review, rewrite, publish, image selection, etc.)
 *
 * NOT responsible for:
 * - long-polling loop (that's entrypoint responsibility)
 * - LLM rewrite logic (delegates to RewriteService)
 */

import { readFile } from 'node:fs/promises';
import type { Api } from 'grammy';
import { resolve } from 'path';
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

// ─── Constants ────────────────────────────────────────────────────────────────

const MEMORY_IMAGES_DIR = './memory/images';
const REWRITE_CALLBACK_PROMPT_PATH = './src/assets/rewrite-system.txt';
const REWRITE_PUBLISH_PROMPT_PATH = './src/assets/rewrite-publish-system.txt';
const REWRITE_PUBLISH_WITH_FEEDBACK_PROMPT_PATH =
  './src/assets/rewrite-publish-feedback-system.txt';

// ─── Types ────────────────────────────────────────────────────────────────────

type TelegramMessage = NonNullable<TelegramUpdate['message']>;
type TelegramCallbackQuery = NonNullable<TelegramUpdate['callback_query']>;

type CallbackHandler = (context: CallbackContext) => Promise<void>;

// ─── Logger ───────────────────────────────────────────────────────────────────

const logger = pino({
  level: FLAGS.VERBOSE ? 'debug' : 'info',
});

// ─── Helper Functions ─────────────────────────────────────────────────────────

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safelyAnswerCallbackQuery(
  telegramService: TelegramMessageService,
  callbackId: string,
  text: string
): Promise<void> {
  try {
    await telegramService.answerCallbackQuery(callbackId, { text });
  } catch (e: unknown) {
    logger.error({ callbackId, errMsg: safeErrorMessage(e) }, 'answerCallbackQuery failed');
  }
}

async function safelyEditMessageReplyMarkup(
  telegramService: TelegramMessageService,
  chatId: string,
  messageId: number
): Promise<void> {
  try {
    await telegramService.editMessageReplyMarkup(chatId, messageId, {
      reply_markup: { inline_keyboard: [] },
    });
  } catch (e: unknown) {
    logger.error(
      { chatId, messageId, errMsg: safeErrorMessage(e) },
      'editMessageReplyMarkup failed'
    );
  }
}

async function safelyEditMessageText(
  telegramService: TelegramMessageService,
  chatId: string,
  messageId: number,
  text: string,
  parseMode: 'HTML' = 'HTML'
): Promise<void> {
  try {
    await telegramService.editMessageText(chatId, messageId, text, { parse_mode: parseMode });
  } catch (e: unknown) {
    logger.error({ chatId, messageId, errMsg: safeErrorMessage(e) }, 'editMessageText failed');
  }
}

// ─── Main Service ─────────────────────────────────────────────────────────────

/**
 * CallbackDispatchService handles all Telegram callback and message events.
 * The daemon entrypoint handles long-polling; this service handles business logic.
 */
export class CallbackDispatchService {
  private readonly backend: BackendClient;
  private readonly telegram: Api;
  private readonly llm: MiniMaxClient;
  private readonly rewriteCallbackPrompt: string;
  private readonly rewritePublishPrompt: string;
  private readonly rewritePublishWithFeedbackPrompt: string;
  private pendingStateService: PendingStateService;
  private rewriteService: RewriteService;
  private imageSearchOrchestrator: ImageSearchOrchestrator | null;
  private telegramService: TelegramMessageService;

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

  // ─── Public API ─────────────────────────────────────────────────────────────

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

  // ─── Update Handlers ────────────────────────────────────────────────────────

  private async handleCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const hasData = Boolean(callbackQuery.data);
    const hasMessage = Boolean(callbackQuery.message);

    if (!hasData || !hasMessage) {
      logger.debug(
        { callbackId: callbackQuery.id, hasData, hasMessage },
        'skip callback query without required fields'
      );
      return;
    }

    const callbackData = callbackQuery.data as string;
    const callbackMessage = callbackQuery.message as {
      chat: { id: number };
      message_id: number;
    };
    const parsed = parseCallbackData(callbackData);

    const context: CallbackContext = {
      callbackId: callbackQuery.id,
      action: parsed.action,
      chatId: String(callbackMessage.chat.id),
      messageId: callbackMessage.message_id,
      postId: parsed.postId,
      imageId: parsed.imageId,
    };

    logger.debug({ callbackId: context.callbackId, action: context.action }, 'route callback');

    await this.routeCallback(context);
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const pending = this.pendingStateService.getPending(chatId);

    if (!pending) {
      return;
    }

    if (message.photo && pending.operation === 'upload_image') {
      this.pendingStateService.clearPending(chatId);
      await this.handlePhotoMessage(chatId, message.photo, pending.postId);
      return;
    }

    const text = message.text;

    if (!text) {
      return;
    }

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

  // ─── Routing ────────────────────────────────────────────────────────────────

  private setPending(chatId: string, state: PendingState): void {
    this.pendingStateService.setPending(chatId, state);
  }

  private clearPending(chatId: string, operation?: PendingOperation): void {
    this.pendingStateService.clearPending(chatId, operation);
  }

  private async routeCallback(context: CallbackContext): Promise<void> {
    const handler = this.actionHandlers.get(context.action);
    if (handler) {
      await handler(context);
      return;
    }
    await this.telegramService.answerCallbackQuery(context.callbackId, {
      text: 'Unknown action',
    });
  }

  private readonly actionHandlers: Map<string, CallbackHandler> = new Map([
    [CALLBACK_ACTION.APPROVE, this.handleApproveOrReject.bind(this)],
    [CALLBACK_ACTION.REJECT, this.handleApproveOrReject.bind(this)],
    [CALLBACK_ACTION.REWRITE, this.handleRewriteAction.bind(this)],
    [CALLBACK_ACTION.REWRITE_NOW, this.handleRewriteNow.bind(this)],
    [CALLBACK_ACTION.SELECT, this.handleSelect.bind(this)],
    [CALLBACK_ACTION.PUBLISHED, this.handlePublishedAction.bind(this)],
    [CALLBACK_ACTION.REWRITE_PUBLISH, this.handleRewritePublishAction.bind(this)],
    [CALLBACK_ACTION.REWRITE_PUBLISH_NOW, this.handleRewritePublishNow.bind(this)],
    [CALLBACK_ACTION.UPLOAD_IMAGE, this.handleUploadImageAction.bind(this)],
    [CALLBACK_ACTION.SEARCH_IMAGES, this.handleSearchImagesAction.bind(this)],
    [CALLBACK_ACTION.PUBLISH_WITHOUT_IMAGE, this.handlePublishWithoutImageAction.bind(this)],
    [CALLBACK_ACTION.CANCEL_SEARCH, this.handleCancelSearch.bind(this)],
    [CALLBACK_ACTION.BACK_TO_REWRITE, this.handleBackToRewriteAction.bind(this)],
    [CALLBACK_ACTION.RESET_FROM_REWRITE, this.handleResetFromRewrite.bind(this)],
    [CALLBACK_ACTION.SELECT_IMAGES, this.handleSelectImagesAction.bind(this)],
    [CALLBACK_ACTION.RESET, this.handleResetAction.bind(this)],
  ]);

  // ─── Callback Handlers (Route Layer) ──────────────────────────────────────

  private async handleApproveOrReject(context: CallbackContext): Promise<void> {
    if (!context.postId) {
      await this.telegramService.answerCallbackQuery(context.callbackId, {
        text: '❌ Error: postId not specified',
      });
      return;
    }
    await this.handleReviewAction(
      context.postId,
      context.action as 'approve' | 'reject',
      context.callbackId,
      context.chatId,
      context.messageId
    );
  }

  private async handleRewriteAction(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    await this.handleRewrite(context.postId, context.callbackId, context.chatId);
  }

  private async handleRewriteNow(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    this.clearPending(context.chatId, 'rewrite_feedback');
    await this.telegramService.answerCallbackQuery(context.callbackId, {
      text: '🔄 Rewriting...',
    });
    await this.doRewrite(context.postId, context.chatId, undefined);
  }

  private async handleSelect(context: CallbackContext): Promise<void> {
    if (!context.postId || context.imageId === undefined) return;
    await this.handleSelectImage(
      context.postId,
      context.imageId,
      context.callbackId,
      context.chatId,
      context.messageId
    );
  }

  private async handlePublishedAction(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    await this.handlePublished(
      context.postId,
      context.callbackId,
      context.chatId,
      context.messageId
    );
  }

  private async handleRewritePublishAction(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    await this.handleRewritePublish(
      context.postId,
      context.callbackId,
      context.chatId,
      context.messageId
    );
  }

  private async handleRewritePublishNow(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    this.clearPending(context.chatId, 'rewrite_publish_feedback');
    await this.telegramService.answerCallbackQuery(context.callbackId, {
      text: '🔄 Rewriting...',
    });
    await this.doRewritePublish(context.postId, context.chatId, undefined);
  }

  private async handleUploadImageAction(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    await this.handleUploadImage(context.postId, context.callbackId, context.chatId);
  }

  private async handleSearchImagesAction(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    await this.handleSearchImages(context.postId, context.callbackId, context.chatId);
  }

  private async handlePublishWithoutImageAction(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    await this.handlePublishWithoutImage(
      context.postId,
      context.callbackId,
      context.chatId,
      context.messageId
    );
  }

  private async handleCancelSearch(context: CallbackContext): Promise<void> {
    this.clearPending(context.chatId, 'image_search');
    await this.telegramService.answerCallbackQuery(context.callbackId, {
      text: 'Cancelled',
    });
  }

  private async handleBackToRewriteAction(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    await this.handleBackToRewrite(context.postId, context.callbackId, context.chatId);
  }

  private async handleResetFromRewrite(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    await this.telegramService.answerCallbackQuery(context.callbackId, {
      text: '🔄 Regenerating...',
    });
    await this.doRewrite(context.postId, context.chatId, undefined, false);
  }

  private async handleSelectImagesAction(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    await this.handleSelectImages(context.postId, context.callbackId, context.chatId);
  }

  private async handleResetAction(context: CallbackContext): Promise<void> {
    if (!context.postId) return;
    await this.handleResetToReview(
      context.postId,
      context.callbackId,
      context.chatId,
      context.messageId
    );
  }

  // ─── Rewrite Handlers ───────────────────────────────────────────────────────

  private async handleRewrite(postId: number, callbackId: string, chatId: string): Promise<void> {
    await this.telegramService.answerCallbackQuery(callbackId, {
      text: '✏️ Write what's wrong',
    });
    this.setPending(chatId, { postId, operation: 'rewrite_feedback' });

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
    usePrevSummary: boolean = true
  ): Promise<void> {
    try {
      const post = await this.backend.getPost(postId);
      const text = post?.original_text || '';

      const systemPrompt = this.rewriteCallbackPrompt;

      const rewriteResult = await this.rewriteService.rewriteForCallback(
        {
          text,
          channelId: post?.channel_telegram_id || String(post?.channel_id || ''),
          prevSummary: usePrevSummary ? (post?.summary ?? undefined) : undefined,
          userFeedback: feedback,
        },
        systemPrompt,
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
    } catch (_e: unknown) {
      logger.error({ postId, chatId }, 'rewrite callback failed');
      await this.telegramService.sendMessage(
        chatId,
        `❌ Error rewriting post #${postId}`
      );
    }
  }

  // ─── Review Handlers ────────────────────────────────────────────────────────

  private async finalizeStatusMessage(
    callbackId: string,
    chatId: string,
    messageId: number,
    statusLabel: string,
    summary?: string
  ): Promise<void> {
    await safelyAnswerCallbackQuery(this.telegramService, callbackId, statusLabel);
    await safelyEditMessageReplyMarkup(this.telegramService, chatId, messageId);

    const text = summary
      ? `<b>${escapeHtml(statusLabel)}</b>\n\n${escapeHtml(summary)}`
      : `<b>${escapeHtml(statusLabel)}</b>`;
    await safelyEditMessageText(this.telegramService, chatId, messageId, text);
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
      await this.handleReviewPostAction(action, postId, callbackId, chatId, messageId, label);
    } catch (_e: unknown) {
      logger.error(
        { postId, action, chatId, messageId, error: safeErrorMessage(_e) },
        'review action failed'
      );
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: 'Error',
      });
    }
  }

  private async handleReviewPostAction(
    action: 'approve' | 'reject',
    postId: number,
    callbackId: string,
    chatId: string,
    messageId: number,
    label: string
  ): Promise<void> {
    const post = action === 'approve' ? await this.fetchApprovedPost(postId, chatId) : null;
    await this.finalizeReviewMessage(callbackId, chatId, messageId, label, post?.summary);

    if (action === 'approve') {
      await this.handleApproveContinuation(postId, post, chatId);
      return;
    }

    await this.sendNextForReview(chatId);
  }

  private async fetchApprovedPost(postId: number, chatId: string): Promise<PostWithDetails | null> {
    try {
      return await this.backend.getPost(postId);
    } catch (e: unknown) {
      logger.error(
        { postId, chatId, error: safeErrorMessage(e) },
        'failed to fetch approved post after review action'
      );
      return null;
    }
  }

  private async finalizeReviewMessage(
    callbackId: string,
    chatId: string,
    messageId: number,
    label: string,
    summary?: string | null
  ): Promise<void> {
    try {
      await this.finalizeStatusMessage(callbackId, chatId, messageId, label, summary ?? undefined);
    } catch (e: unknown) {
      logger.error(
        { chatId, messageId, error: safeErrorMessage(e) },
        'failed to finalize review status message'
      );
    }
  }

  private async handleApproveContinuation(
    postId: number,
    post: PostWithDetails | null,
    chatId: string
  ): Promise<void> {
    if (post) {
      await this.sendPostForPublish(post, chatId);
      return;
    }
    await this.telegramService.sendMessage(
      chatId,
      `❌ Post #${postId} approved, but failed to prepare for publishing.`
    );
  }

  private async sendNextForReview(chatId: string): Promise<void> {
    try {
      const result = await this.backend.getNextForReview({ ignoreCooldown: true });
      if (!result) return;

      await this.sendReviewPost(chatId, result.post);
    } catch (e: unknown) {
      logger.error({ chatId, error: safeErrorMessage(e) }, 'failed to send next review post');
    }
  }

  private async sendReviewPost(
    chatId: string,
    post: PostWithDetails | PostForReview
  ): Promise<void> {
    const text = this.buildReviewPostText(post);
    const replyMarkup = await this.buildReviewReplyMarkup(post);

    await this.backend.updatePost(post.id, { user_feedback: 'review_sending' });

    try {
      await this.sendReviewContent(chatId, post, text, replyMarkup);
    } catch (tgErr: unknown) {
      await this.backend.updatePost(post.id, { user_feedback: null });
      throw tgErr;
    }

    await this.backend.updatePost(post.id, { user_feedback: 'review_sent' });
  }

  private buildReviewPostText(post: PostWithDetails | PostForReview): string {
    const channelTelegramId =
      'channel_telegram_id' in post ? post.channel_telegram_id : post.channel_id;
    const channelSlug = (channelTelegramId || '').toString().replace('@', '');
    const origUrl =
      channelSlug && post.telegram_msg_id
        ? `\n\n<a href="${buildTelegramPostUrl(channelSlug, post.telegram_msg_id)}">Source</a>`
        : '';
    return `<b>${escapeHtml(post.channel_name || '')}</b>\n\n${escapeHtml(post.summary || '')}${origUrl}`;
  }

  private async buildReviewReplyMarkup(post: PostWithDetails | PostForReview) {
    const images = post.images ?? [];
    const originalImage = images.find((i) => i.image_type === 'original');
    const hasLocalPath = originalImage?.local_path && (await fileExists(originalImage.local_path));
    const originalImageId = hasLocalPath && originalImage ? originalImage.id : undefined;
    return buildReviewButtons(post.id, originalImageId);
  }

  private async sendReviewContent(
    chatId: string,
    post: PostWithDetails | PostForReview,
    text: string,
    replyMarkup: ReturnType<typeof buildReviewButtons>
  ): Promise<void> {
    const images = post.images ?? [];
    const originalImage = images.find((i) => i.image_type === 'original');
    const hasLocalPath = originalImage?.local_path && (await fileExists(originalImage.local_path));

    if (hasLocalPath && originalImage?.local_path) {
      await this.telegramService.sendPhoto(chatId, originalImage.local_path, {
        caption: text,
        parse_mode: 'HTML',
      });
      await this.telegramService.sendMessage(chatId, `📋 Post #${post.id} sent for review.`, {
        reply_markup: replyMarkup,
      });
    } else {
      await this.telegramService.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
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

  // ─── Image Selection Handlers ──────────────────────────────────────────────

  private async handleSelectImage(
    postId: number,
    imageId: number,
    callbackId: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    try {
      await this.backend.selectImage(postId, imageId);
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: '🖼️ Image selected',
      });
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
      if (freshPost) {
        await this.sendPostForPublish(freshPost, chatId);
      }
    } catch (_e: unknown) {
      logger.error({ postId, imageId, chatId, messageId }, 'image selection failed');
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: 'Error',
      });
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
      const updatedPost = await this.backend.getPost(postId);
      await this.finalizeStatusMessage(
        callbackId,
        chatId,
        messageId,
        '✅ Published',
        updatedPost?.summary || ''
      );
      await this.sendNextForReview(chatId);
    } catch (_e: unknown) {
      logger.error({ postId, chatId, messageId }, 'mark published failed');
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: 'Error',
      });
    }
  }

  // ─── Upload Handlers ────────────────────────────────────────────────────────

  private async handleUploadImage(
    postId: number,
    callbackId: string,
    chatId: string
  ): Promise<void> {
    this.setPending(chatId, { postId, operation: 'upload_image' });
    await this.telegramService.answerCallbackQuery(callbackId, {
      text: '📷 Send an image',
    });
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
      const largest = photoSizes[photoSizes.length - 1];
      const fileId = largest.file_id;

      const fileResult = await this.telegram.getFile(fileId);
      const filePath = fileResult.file_path;
      if (!filePath) return;

      if (!NEUROVANYA_BOT_TOKEN) return;
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

      const postWithImages = await this.backend.getPost(postId);
      const images = postWithImages?.images || [];
      const userImage = images.find((i) => i.type === 'found_1' || i.source === 'user_upload');
      if (userImage) {
        await this.backend.selectImage(postId, userImage.id as number);
      }

      await this.telegramService.sendMessage(chatId, `✅ Image saved for post #${postId}`);

      const freshPost = await this.backend.getPost(postId);
      if (freshPost) {
        await this.sendPostForPublish(freshPost, chatId);
      }
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error({ postId, chatId, error: errorMessage }, 'user image upload failed');
      await this.telegramService.sendMessage(
        chatId,
        `❌ Error saving image: ${errorMessage}`
      );
    }
  }

  // ─── Rewrite Publish Handlers ──────────────────────────────────────────────

  private async handleRewritePublish(
    postId: number,
    callbackId: string,
    chatId: string,
    _messageId: number
  ): Promise<void> {
    this.setPending(chatId, { postId, operation: 'rewrite_publish_feedback' });
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
      const prevSummary = post?.summary;

      const systemPrompt = feedback
        ? this.rewritePublishWithFeedbackPrompt
        : this.rewritePublishPrompt;

      const rewriteResult = await this.rewriteService.rewriteForPublish(
        {
          text,
          channelId: post?.channel_telegram_id || String(post?.channel_id || ''),
          prevSummary: prevSummary || undefined,
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
      const selectedId = freshPost?.selected_image_id;
      const images = freshPost?.images || [];
      const selectedImg = images.find((i) => i.id === selectedId);
      const selectedPath = selectedImg?.local_path;

      if (selectedPath && (await fileExists(selectedPath))) {
        await this.telegramService.sendPhoto(chatId, selectedPath, {
          caption: newText,
          parse_mode: 'HTML',
        });
      } else {
        await this.telegramService.sendMessage(chatId, newText, {
          parse_mode: 'HTML',
        });
      }

      const keyboard = buildPublishKeyboard(postId);
      await this.telegramService.sendMessage(
        chatId,
        `📋 Post #${postId} rewritten. Press "Published" when you forward it to the channel.`,
        { reply_markup: keyboard }
      );
    } catch (_e: unknown) {
      logger.error({ postId, chatId }, 'publish rewrite failed');
      await this.telegramService.sendMessage(
        chatId,
        `❌ Error rewriting post #${postId}`
      );
    }
  }

  // ─── Image Search Handlers ──────────────────────────────────────────────────

  private async handleSearchImages(
    postId: number,
    callbackId: string,
    chatId: string
  ): Promise<void> {
    this.setPending(chatId, { postId, operation: 'image_search' });
    await this.telegramService.answerCallbackQuery(callbackId, {
      text: '🔍 Enter a search query',
    });
    const keyboard = buildCancelSearchKeyboard(postId);
    await this.telegramService.sendMessage(
      chatId,
      `🔍 Enter a search query for post #${postId}:`,
      {
        reply_markup: keyboard,
      }
    );
  }

  private async doSearchImages(postId: number, chatId: string, query: string): Promise<void> {
    if (!this.imageSearchOrchestrator) {
      await this.telegramService.sendMessage(chatId, `❌ Tavily API key not configured`);
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
        await this.handleSearchError(chatId, postId, normalizedQuery, result.error);
        return;
      }

      if (result.imageState) {
        await this.sendImageSelection(chatId, postId, result.imageState);
      }
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error(
        { postId, chatId, query: normalizedQuery, error: errorMessage },
        'image search threw error'
      );
      await this.telegramService.sendMessage(chatId, `❌ Search error: ${errorMessage}`);
    }
  }

  private async handleSearchError(
    chatId: string,
    postId: number,
    normalizedQuery: string,
    error: string | undefined
  ): Promise<void> {
    if (error === 'no_pages_found') {
      const imageState = await this.imageSearchOrchestrator!.getImageState(postId);
      await this.sendNoSearchResults(
        chatId,
        postId,
        normalizedQuery,
        imageState.hasOriginalLocal,
        imageState.originalImage?.id
      );
    } else if (error === 'no_images_found') {
      await this.telegramService.sendMessage(
        chatId,
        `😕 No images found for query: ${normalizedQuery}`
      );
    } else if (error === 'no_valid_images') {
      await this.telegramService.sendMessage(
        chatId,
        `😕 Could not find valid images in 6 attempts`
      );
    } else {
      logger.error({ postId, chatId, query: normalizedQuery, error }, 'image search failed');
      await this.telegramService.sendMessage(chatId, `❌ Search error: ${error}`);
    }
  }

  // ─── Other Handlers ─────────────────────────────────────────────────────────

  private async handlePublishWithoutImage(
    postId: number,
    callbackId: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    try {
      await this.backend.updatePost(postId, {
        status: 'ready_publish',
        selected_image_id: null,
      });
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: '📸 Sending...',
      });
      await this.telegramService.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: { inline_keyboard: [] },
      });
      await this.telegramService.editMessageText(chatId, messageId, '<b>📸 Without image</b>', {
        parse_mode: 'HTML',
      });
      const freshPost = await this.backend.getPost(postId);
      if (freshPost) {
        await this.sendPostForPublish(freshPost, chatId);
      }
    } catch (_e: unknown) {
      logger.error({ postId, chatId, messageId }, 'publish without image failed');
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: 'Error',
      });
    }
  }

  private async handleBackToRewrite(
    postId: number,
    callbackId: string,
    chatId: string
  ): Promise<void> {
    await this.telegramService.answerCallbackQuery(callbackId, {
      text: '◀️ Going back',
    });
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
    const keyboard = buildRewriteKeyboard(postId);
    await this.telegramService.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  private async handleSelectImages(
    postId: number,
    callbackId: string,
    chatId: string
  ): Promise<void> {
    await this.telegramService.answerCallbackQuery(callbackId, {
      text: '🖼️ Loading options...',
    });
    const imageState = await this.getImageState(postId);
    const foundImages = imageState.foundImages;

    if (foundImages.length === 0) {
      await this.telegramService.sendMessage(chatId, `❌ No images found for post #${postId}`);
      return;
    }

    await this.sendImageSelection(chatId, postId, imageState);
  }

  private async getImageState(postId: number): Promise<{
    foundImages: PostImage[];
    originalImage?: PostImage;
    originalLocalPath?: string;
    hasOriginalLocal: boolean;
  }> {
    const post = await this.backend.getPost(postId);
    const images = post?.images || [];

    const foundImages = images.filter((image) =>
      (image.type || image.image_type || '').toString().startsWith('found_')
    );
    const originalImage = images.find((image) => (image.type || image.image_type) === 'original');
    const originalLocalPath = originalImage?.local ?? originalImage?.local_path ?? undefined;
    const hasOriginalLocal = Boolean(originalLocalPath && (await fileExists(originalLocalPath)));

    return {
      foundImages,
      originalImage,
      originalLocalPath,
      hasOriginalLocal,
    };
  }

  private async sendImageSelection(
    chatId: string,
    postId: number,
    imageState: {
      foundImages: PostImage[];
      originalImage?: PostImage;
      originalLocalPath?: string;
      hasOriginalLocal: boolean;
    }
  ): Promise<void> {
    await this.sendImageMediaGroup(chatId, postId, imageState);

    const imageIds = imageState.foundImages.map((image) => image.id);
    const originalId = imageState.originalImage?.id;
    const replyMarkup = buildImageChoiceButtons(postId, imageIds, originalId);

    await this.telegramService.sendMessage(chatId, `Select an image for post #${postId}:`, {
      reply_markup: replyMarkup,
    });
  }

  private async sendImageMediaGroup(
    chatId: string,
    postId: number,
    imageState: {
      foundImages: PostImage[];
      originalLocalPath?: string;
      hasOriginalLocal: boolean;
    }
  ): Promise<void> {
    const downloadable = (
      await Promise.all(
        imageState.foundImages.map(async (image) => {
          const localPath = image.local_path;

          if (!localPath) {
            return null;
          }

          const exists = await fileExists(localPath);

          if (!exists) {
            return null;
          }

          return { ...image, local_path: localPath };
        })
      )
    ).filter((img): img is PostImage & { local_path: string } => img !== null);

    if (downloadable.length === 0) {
      return;
    }

    const mediaItems = downloadable.map((image, index) => ({
      type: 'photo' as const,
      media: image.local_path,
      caption: index === 0 ? `Image options for post #${postId}` : undefined,
    }));

    if (imageState.hasOriginalLocal && imageState.originalLocalPath) {
      mediaItems.unshift({
        type: 'photo' as const,
        media: imageState.originalLocalPath,
        caption: '🖼️ Original',
      });
    }

    try {
      await this.telegramService.sendMediaGroup(chatId, mediaItems);
    } catch (_e: unknown) {
      logger.debug({ postId, chatId }, 'failed to send media group');
    }
  }

  private async sendNoSearchResults(
    chatId: string,
    postId: number,
    query: string,
    hasOriginalLocal: boolean,
    originalImageId?: number
  ): Promise<void> {
    const noResultsText = hasOriginalLocal
      ? `😕 Nothing found for query: ${query}\n🖼️ You can select the original.`
      : `😕 Nothing found for query: ${query}`;

    await this.telegramService.sendMessage(chatId, noResultsText);

    if (!hasOriginalLocal || originalImageId === undefined) {
      return;
    }

    const replyMarkup = buildOnlyOriginalSelection(postId, originalImageId);

    await this.telegramService.sendMessage(chatId, `Select an image for post #${postId}:`, {
      reply_markup: replyMarkup,
    });
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
    } catch (_e: unknown) {
      logger.error({ postId, chatId, messageId }, 'reset to review failed');
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: 'Error',
      });
    }
  }
}
