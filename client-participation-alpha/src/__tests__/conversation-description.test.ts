import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactRenderer from '@astrojs/react/server.js';
import { beforeEach, expect, test, vi } from 'vitest';

const { polisGet } = vi.hoisted(() => ({ polisGet: vi.fn() }));

vi.mock('../lib/net', () => ({
  default: { polisGet },
}));

import ConversationPage from '../pages/[conversation_id].astro';

async function renderWithDescription(description: string): Promise<string> {
  polisGet.mockResolvedValue({
    conversation: {
      conversation_id: '2testid',
      topic: 'Topic',
      description,
      is_active: false,
    },
    nextComment: null,
  });
  const container = await AstroContainer.create();
  container.addServerRenderer({ renderer: reactRenderer, name: '@astrojs/react' });
  return container.renderToString(ConversationPage, {
    params: { conversation_id: '2testid' },
    request: new Request('https://assembly.test/2testid'),
  });
}

function descriptionOf(html: string): string {
  const paragraphs = [...html.matchAll(/<p class="description"[^>]*>([\s\S]*?)<\/p>/g)];
  expect(paragraphs).toHaveLength(1);
  return paragraphs[0][1].replace(/ data-astro-source-(file|loc)="[^"]*"/g, '');
}

beforeEach(() => {
  polisGet.mockReset();
});

test.each([
  {
    name: 'markup is shown as text',
    description:
      '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>',
    expected:
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;&lt;a href=&quot;javascript:alert(3)&quot;&gt;x&lt;/a&gt;',
  },
  {
    name: 'line breaks are kept and markup between them is shown as text',
    description: 'First line\nSecond <b>line</b>\n\nFourth line',
    expected: 'First line<br>Second &lt;b&gt;line&lt;/b&gt;<br><br>Fourth line',
  },
  {
    name: 'line breaks written with a carriage return are kept',
    description: 'First <i>line</i>\r\nSecond line',
    expected: 'First &lt;i&gt;line&lt;/i&gt;<br>Second line',
  },
  {
    name: 'a line break written as markup is shown as text',
    description: 'First line<br>Second line',
    expected: 'First line&lt;br&gt;Second line',
  },
])('$name', async ({ description, expected }) => {
  const html = await renderWithDescription(description);

  expect(descriptionOf(html)).toBe(expected);
  expect(polisGet.mock.calls).toEqual([
    ['/participationInit', { conversation_id: '2testid', includePCA: false }],
  ]);
});
