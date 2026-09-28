import { describe, expect, it } from 'vitest';
import { encryptMaxRecipient } from '@vibework/shared';
import { MaxBotReplyTransport } from '../src/max-reply-transport.js';

const key = Buffer.alloc(32, 2).toString('base64url');

describe('MAX reply transport', () => {
  it('sends encrypted recipients with callback and mini-app inline buttons', async () => {
    const calls: unknown[] = [];
    const transport = new MaxBotReplyTransport(
      {
        sendMessage(input) {
          calls.push(input);
          return Promise.resolve({});
        },
        answerCallback(input) {
          calls.push(input);
          return Promise.resolve({});
        },
      },
      key,
    );
    await transport.deliver({
      deliveryId: 'internal-only',
      encryptedRecipient: encryptMaxRecipient('42', key),
      text: 'Готово',
      buttons: [{ label: 'Продолжить', payload: 'b1o' }],
      miniApp: { label: 'Открыть урок', url: 'https://vibeworkrussia.ru' },
    });
    await transport.acknowledgeCallback('callback-1');
    expect(calls).toEqual([
      {
        userId: '42',
        text: 'Готово',
        attachments: [
          {
            type: 'inline_keyboard',
            payload: {
              buttons: [
                [{ type: 'callback', text: 'Продолжить', payload: 'b1o' }],
                [
                  {
                    type: 'link',
                    text: 'Открыть урок',
                    url: 'https://vibeworkrussia.ru',
                  },
                ],
              ],
            },
          },
        ],
      },
      { callbackId: 'callback-1' },
    ]);
  });
});
