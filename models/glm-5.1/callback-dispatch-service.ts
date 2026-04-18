// Refactored by builder-1 (glm-5.1)
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
import { resolve } from 'path';
import pino from 'pino';
import type { Api } from 'grammy';
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
import { FLAGS, MEMORY_IMAGES_DIR, NEUROVANYA_BOT_TOKEN } from '../shared/config.ts';
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
import type { ImageSearchOrchestrator } from './image-search-orchestrator.ts';
import { createImageSearchOrchestrator } from './image-search-orchestrator.ts';
import type { PublishDispatchService as PublishDispatchServiceType } from './publish-dispatch-service.ts';
import { PublishDispatchService } from './publish-dispatch-service.ts';
import type {
  PendingOperation,
  PendingState,
  PendingStateService,
} from './pending-state-service.ts';
import { createPendingStateService } from './pending-state-service.ts';
import type { RewriteService } from './rewrite-service.ts';
import { createRewriteService } from './rewrite-service.ts';
import { TelegramMessageService } from './telegram-message-service.ts';

// ── Local types ─────────────────────────────────────────────────────

type TelegramMessage = NonNullable<TelegramUpdate['message']>;
type TelegramCallbackQuery = NonNullable<TelegramUpdate['callback_query']>;
type CallbackHandler = (context: CallbackContext) => Promise<void>;

/** Image state returned by getImageState() */
interface ImageStateResult {
  foundImages: PostImage[];
  originalImage?: PostImage;
  originalLocalPath?: string;
  hasOriginalLocal: boolean;
}

/** Image state for sendImageSelection() */
interface ImageSelectionState {
  foundImages: PostImage[];
  originalImage?: PostImage;
  originalLocalPath?: string;
  hasOriginalLocal: boolean;
}

/** Image state for sendImageMediaGroup() */
interface ImageMediaGroupState {
  foundImages: PostImage[];
  originalLocalPath?: string;
  hasOriginalLocal: boolean;
}

/** Actionable callback query with required data + message */
type ActionableCallbackQuery = TelegramCallbackQuery & {
  data: string;
  message: { chat: { id: number }; message_id: number };
};

// ── Constants ───────────────────────────────────────────────────────

const REWRITE_CALLBACK_PROMPT_PATH = './src/assets/rewrite-system.txt';
const REWRITE_PUBLISH_PROMPT_PATH = './src/assets/rewrite-publish-system.txt';
const REWRITE_PUBLISH_WITH_FEEDBACK_PROMPT_PATH =
  './src/assets/rewrite-publish-feedback-system.txt';

const logger = pino({
  level: FLAGS.VERBOSE ? 'debug' : 'info',
});

// ── Type guard ──────────────────────────────────────────────────────

function isActionableCallback(query: TelegramCallbackQuery): query is ActionableCallbackQuery {
  return Boolean(query.data) && Boolean(query.message);
}

// ── Main service ────────────────────────────────────────────────────

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
  private readonly pendingStateService: PendingStateService;
  private readonly rewriteService: RewriteService;
  private readonly imageSearchOrchestrator: ImageSearchOrchestrator | null;
  private readonly telegramService: TelegramMessageService;
  private readonly publishDispatch: PublishDispatchServiceType;

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
    this.publishDispatch = new PublishDispatchService(this.backend, this.telegram);

    if (!this.imageSearchOrchestrator) {
      logger.warn('ImageSearchOrchestrator not initialized - TAVILY_API_KEY may be missing');
    }
  }

  static async create(
    backend: BackendClient,
    telegram: Api,
    llm: MiniMaxClient
  ): Promise<CallbackDispatchService> {
    const prompts = await Promise.all([
      readFile(REWRITE_CALLBACK_PROMPT_PATH, 'utf-8').then((s) => s.trim()),
      readFile(REWRITE_PUBLISH_PROMPT_PATH, 'utf-8').then((s) => s.trim()),
      readFile(REWRITE_PUBLISH_WITH_FEEDBACK_PROMPT_PATH, 'utf-8').then((s) => s.trim()),
    ]);

    return new CallbackDispatchService(backend, telegram, llm, prompts[0], prompts[1], prompts[2]);
  }

  // ── Public entry point ─────────────────────────────────────────────

  /** Process a single Telegram update (callback query or message) */
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

  // ── Callback query routing ─────────────────────────────────────────

  private async handleCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
    if (!isActionableCallback(callbackQuery)) {
      logger.debug(
        {
          callbackId: callbackQuery.id,
          hasData: Boolean(callbackQuery.data),
          hasMessage: Boolean(callbackQuery.message),
        },
        'skip callback query without required fields'
      );
      return;
    }

    const parsed = parseCallbackData(callbackQuery.data);
    const context: CallbackContext = {
      callbackId: callbackQuery.id,
      action: parsed.action,
      chatId: String(callbackQuery.message.chat.id),
      messageId: callbackQuery.message.message_id,
      postId: parsed.postId,
      imageId: parsed.imageId,
    };

    logger.debug({ callbackId: context.callbackId, action: context.action }, 'route callback');
    await this.routeCallback(context);
  }

  private async routeCallback(context: CallbackContext): Promise<void> {
    const handler: CallbackHandler | undefined = this.actionHandlers.get(context.action);
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

  // ── Message handling (pending state) ──────────────────────────────

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

    const messageHandlers: Record<PendingOperation, () => Promise<void>> = {
      rewrite_feedback: () => this.doRewrite(pending.postId, chatId, text),
      rewrite_publish_feedback: () => this.doRewritePublish(pending.postId, chatId, text),
      image_search: () => this.doSearchImages(pending.postId, chatId, text),
      upload_image: () => Promise.resolve(),
    };

    await messageHandlers[pending.operation]();
  }

  // ── Action handler dispatchers ────────────────────────────────────

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
    this.pendingStateService.clearPending(context.chatId, 'rewrite_feedback');
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
    this.pendingStateService.clearPending(context.chatId, 'rewrite_publish_feedback');
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
    this.pendingStateService.clearPending(context.chatId, 'image_search');
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

  // ── Rewrite handlers ───────────────────────────────────────────────

  private async handleRewrite(postId: number, callbackId: string, chatId: string): Promise<void> {
    await this.telegramService.answerCallbackQuery(callbackId, {
      text: '✏️ Write what's wrong',
    });
    this.pendingStateService.setPending(chatId, { postId, operation: 'rewrite_feedback' });

    const keyboard = buildRewriteNoFeedbackKeyboard(postId);
    const promptText = `✏️ Write what's wrong with post #${postId} text (or press "No comment"):`;
    await this.telegramService.sendMessage(chatId, promptText, {
      reply_markup: keyboard,
    });
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
      const channelId = post?.channel_telegram_id || String(post?.channel_id || '');

      const rewriteInput = {
        text,
        channelId,
        prevSummary: usePrevSummary ? (post?.summary ?? undefined) : undefined,
        userFeedback: feedback,
      };
      const rewriteResult = await this.rewriteService.rewriteForCallback(
        rewriteInput,
        this.rewriteCallbackPrompt,
        usePrevSummary
      );

      if (!rewriteResult.success || !rewriteResult.summary) {
        const errorMsg = rewriteResult.error || 'MiniMax returned empty response';
        await this.telegramService.sendMessage(
          chatId,
          `❌ ${errorMsg} for post #${postId}. Try "Rewrite" again.`
        );
        return;
      }

      const summary = rewriteResult.summary;
      await this.backend.generateSummary(postId, summary);

      const telegramMessageId =
        typeof post?.telegram_msg_id === 'number' ? post.telegram_msg_id : undefined;
      const channelName = post?.channel_name || '';
      const channelTelegramId = post?.channel_telegram_id || String(post?.channel_id || '');
      const newText = formatPostTextWithSource(
        channelName,
        summary,
        channelTelegramId,
        telegramMessageId
      );

      const keyboard = buildRewriteKeyboard(postId);
      await this.telegramService.sendMessage(chatId, newText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ postId, chatId, error: errMsg }, 'rewrite callback failed');
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
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: statusLabel,
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ callbackId, errMsg }, 'answerCallbackQuery failed in finalizeStatusMessage');
    }

    try {
      await this.telegramService.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { chatId, messageId, errMsg },
        'editMessageReplyMarkup failed in finalizeStatusMessage'
      );
    }

    const text = summary
      ? `<b>${escapeHtml(statusLabel)}</b>\n\n${escapeHtml(summary)}`
      : `<b>${escapeHtml(statusLabel)}</b>`;

    try {
      await this.telegramService.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { chatId, messageId, errMsg },
        'editMessageText failed in finalizeStatusMessage'
      );
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
      const post = action === 'approve' ? await this.fetchApprovedPost(postId, chatId) : null;

      await this.finalizeReviewMessage(callbackId, chatId, messageId, label, post?.summary);

      if (action === 'approve') {
        await this.handleApproveContinuation(postId, post, chatId);
        return;
      }

      await this.sendNextForReview(chatId);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ postId, action, chatId, messageId, error: errMsg }, 'review action failed');
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: 'Error',
      });
    }
  }

  private async fetchApprovedPost(postId: number, chatId: string): Promise<PostWithDetails | null> {
    try {
      return await this.backend.getPost(postId);
    } catch (error: unknown) {
      logger.error(
        { postId, chatId, error: error instanceof Error ? error.message : String(error) },
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
    } catch (error: unknown) {
      logger.error(
        { chatId, messageId, error: error instanceof Error ? error.message : String(error) },
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
    } catch (error: unknown) {
      logger.error(
        { chatId, error: error instanceof Error ? error.message : String(error) },
        'failed to send next review post'
      );
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

  private async buildReviewReplyMarkup(
    post: PostWithDetails | PostForReview
  ): Promise<ReturnType<typeof buildReviewButtons>> {
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
    const result = await this.publishDispatch.dispatch({ post, chatId });

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
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: '🖼️ Image selected',
      });
      await this.telegramService.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: { inline_keyboard: [] },
      });
      const selectionText = `<b>✅ Image selected</b> (image_id=${imageId})`;
      await this.telegramService.editMessageText(chatId, messageId, selectionText, {
        parse_mode: 'HTML',
      });

      const freshPost = await this.backend.getPost(postId);
      if (freshPost) {
        await this.sendPostForPublish(freshPost, chatId);
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ postId, imageId, chatId, messageId, error: errMsg }, 'image selection failed');
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
      const summary = updatedPost?.summary || '';
      await this.finalizeStatusMessage(callbackId, chatId, messageId, '✅ Published', summary);
      await this.sendNextForReview(chatId);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ postId, chatId, messageId, error: errMsg }, 'mark published failed');
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: 'Error',
      });
    }
  }

  // ── Upload handlers ───────────────────────────────────────────────

  private async handleUploadImage(
    postId: number,
    callbackId: string,
    chatId: string
  ): Promise<void> {
    this.pendingStateService.setPending(chatId, { postId, operation: 'upload_image' });
    await this.telegramService.answerCallbackQuery(callbackId, {
      text: '📷 Send an image',
    });
    const uploadPrompt = `📷 Send an image for post #${postId} as the next message.`;
    await this.telegramService.sendMessage(chatId, uploadPrompt);
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
      const localPath = resolve(MEMORY_IMAGES_DIR, filename);

      await this.backend.downloadImage(fileUrl, filename);

      const imageRecord = {
        url: fileUrl,
        source: 'user_upload' as const,
        local_path: localPath,
      };
      await this.backend.saveImages(postId, [imageRecord]);

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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ postId, chatId, error: errorMessage }, 'user image upload failed');
      await this.telegramService.sendMessage(
        chatId,
        `❌ Error saving image: ${errorMessage}`
      );
    }
  }

  // ── Rewrite publish handlers ──────────────────────────────────────

  private async handleRewritePublish(
    postId: number,
    callbackId: string,
    chatId: string,
    _messageId: number
  ): Promise<void> {
    this.pendingStateService.setPending(chatId, {
      postId,
      operation: 'rewrite_publish_feedback',
    });
    await this.telegramService.answerCallbackQuery(callbackId, {
      text: '✏️ Write what to fix',
    });
    const keyboard = buildPublishNoFeedback(postId);
    const rewritePrompt = `✏️ Write what to fix in post #${postId} (or press "No comment"):`;
    await this.telegramService.sendMessage(chatId, rewritePrompt, {
      reply_markup: keyboard,
    });
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
      const channelId = post?.channel_telegram_id || String(post?.channel_id || '');

      const systemPrompt = feedback
        ? this.rewritePublishWithFeedbackPrompt
        : this.rewritePublishPrompt;

      const rewriteInput = {
        text,
        channelId,
        prevSummary: prevSummary || undefined,
        userFeedback: feedback,
      };
      const rewriteResult = await this.rewriteService.rewriteForPublish(rewriteInput, systemPrompt);

      if (!rewriteResult.success || !rewriteResult.summary) {
        const errorMsg = rewriteResult.error || 'MiniMax returned empty response';
        await this.telegramService.sendMessage(
          chatId,
          `❌ ${errorMsg} for post #${postId}. Try "Rewrite" again.`
        );
        return;
      }

      const summary = rewriteResult.summary;
      await this.backend.generateSummary(postId, summary);

      const channelName = post?.channel_name || '';
      const newText = formatPostTextWithoutSource(channelName, summary);

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
      const publishNotice = `📋 Post #${postId} rewritten. Press "Published" when you forward it to the channel.`;
      await this.telegramService.sendMessage(chatId, publishNotice, {
        reply_markup: keyboard,
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ postId, chatId, error: errMsg }, 'publish rewrite failed');
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
    const searchPrompt = `🔍 Enter a search query for post #${postId}:`;
    await this.telegramService.sendMessage(chatId, searchPrompt, {
      reply_markup: keyboard,
    });
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
        await this.handleSearchError(result.error, postId, chatId, normalizedQuery);
        return;
      }

      if (result.imageState) {
        await this.sendImageSelection(chatId, postId, result.imageState);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        { postId, chatId, query: normalizedQuery, error: errorMessage },
        'image search threw error'
      );
      await this.telegramService.sendMessage(chatId, `❌ Search error: ${errorMessage}`);
    }
  }

  private async handleSearchError(
    error: string | undefined,
    postId: number,
    chatId: string,
    normalizedQuery: string
  ): Promise<void> {
    if (error === 'no_pages_found') {
      const orchestrator = this.imageSearchOrchestrator!;
      const imageState = await orchestrator.getImageState(postId);
      await this.sendNoSearchResults(
        chatId,
        postId,
        normalizedQuery,
        imageState.hasOriginalLocal,
        imageState.originalImage?.id
      );
      return;
    }

    if (error === 'no_images_found') {
      await this.telegramService.sendMessage(
        chatId,
        `😕 No images found for query: ${normalizedQuery}`
      );
      return;
    }

    if (error === 'no_valid_images') {
      await this.telegramService.sendMessage(
        chatId,
        `😕 Could not find valid images in 6 attempts`
      );
      return;
    }

    logger.error({ postId, chatId, query: normalizedQuery, error }, 'image search failed');
    await this.telegramService.sendMessage(chatId, `❌ Search error: ${error}`);
  }

  // ── Other handlers ────────────────────────────────────────────────

  private async handlePublishWithoutImage(
    postId: number,
    callbackId: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    try {
      const updatePayload = {
        status: 'ready_publish' as const,
        selected_image_id: null as null,
      };
      await this.backend.updatePost(postId, updatePayload);
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
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ postId, chatId, messageId, error: errMsg }, 'publish without image failed');
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

  // ── Image state helpers ───────────────────────────────────────────

  private async getImageState(postId: number): Promise<ImageStateResult> {
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
    imageState: ImageSelectionState
  ): Promise<void> {
    await this.sendImageMediaGroup(chatId, postId, imageState);

    const imageIds = imageState.foundImages.map((image) => image.id);
    const originalId = imageState.originalImage?.id;
    const replyMarkup = buildImageChoiceButtons(postId, imageIds, originalId);

    const selectionPrompt = `Select an image for post #${postId}:`;
    await this.telegramService.sendMessage(chatId, selectionPrompt, {
      reply_markup: replyMarkup,
    });
  }

  private async sendImageMediaGroup(
    chatId: string,
    postId: number,
    imageState: ImageMediaGroupState
  ): Promise<void> {
    const downloadable = await this.collectDownloadableImages(imageState.foundImages);

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
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.debug({ postId, chatId, error: errMsg }, 'failed to send media group');
    }
  }

  private async collectDownloadableImages(
    images: PostImage[]
  ): Promise<Array<PostImage & { local_path: string }>> {
    const checked = await Promise.all(
      images.map(async (image) => {
        const localPath = image.local_path;
        if (!localPath) return null;

        const exists = await fileExists(localPath);
        if (!exists) return null;

        return { ...image, local_path: localPath };
      })
    );
    return checked.filter((img): img is PostImage & { local_path: string } => img !== null);
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
    const selectionPrompt = `Select an image for post #${postId}:`;
    await this.telegramService.sendMessage(chatId, selectionPrompt, {
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
      const summary = post?.summary || '';
      await this.finalizeStatusMessage(
        callbackId,
        chatId,
        messageId,
        '🔄 Returned for revision',
        summary
      );
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ postId, chatId, messageId, error: errMsg }, 'reset to review failed');
      await this.telegramService.answerCallbackQuery(callbackId, {
        text: 'Error',
      });
    }
  }
}
