import { decryptMaxRecipient } from '@vibework/shared';
import type { MaxApiClient } from '../../api/src/max-client.js';
import type { BotReplyTransport } from './max-bot.js';

type InlineButton =
  | { type: 'callback'; text: string; payload: string }
  | { type: 'link'; text: string; url: string };

type ReplyClient = Pick<MaxApiClient, 'sendMessage' | 'answerCallback'>;

function inlineKeyboard(input: {
  buttons: { label: string; payload: string }[];
  miniApp?: { label: string; url: string };
}): unknown[] | undefined {
  const buttons: InlineButton[][] = input.buttons.map((button) => [
    { type: 'callback', text: button.label, payload: button.payload },
  ]);
  if (input.miniApp)
    // MAX `open_app` requires a separately configured public bot name (`web_app`),
    // while this deployment deliberately configures only the verified app URL.
    buttons.push([{ type: 'link', text: input.miniApp.label, url: input.miniApp.url }]);
  return buttons.length === 0
    ? undefined
    : [{ type: 'inline_keyboard', payload: { buttons } }];
}

/**
 * The only adapter that decrypts a MAX recipient.  It keeps the value local to
 * this call and passes it directly as the documented `user_id` query parameter.
 */
export class MaxBotReplyTransport implements BotReplyTransport {
  constructor(
    private readonly client: ReplyClient,
    private readonly identityEncryptionKey: string,
  ) {}

  async deliver(input: {
    deliveryId: string;
    encryptedRecipient: string;
    text: string;
    buttons: { label: string; payload: string }[];
    miniApp?: { label: string; url: string };
  }): Promise<void> {
    // deliveryId is intentionally not sent to MAX: it is internal outbox state.
    const attachments = inlineKeyboard(input);
    await this.client.sendMessage({
      userId: decryptMaxRecipient(input.encryptedRecipient, this.identityEncryptionKey),
      text: input.text,
      ...(attachments === undefined ? {} : { attachments }),
    });
  }

  acknowledgeCallback(callbackId: string): Promise<void> {
    return this.client.answerCallback({ callbackId }).then(() => undefined);
  }
}
