import { assertSafeCategoryUrl } from './config.js';

/**
 * Ask the external categorizer (an n8n workflow with an LLM that holds the category list) for the
 * category of a transaction, by its description as scraped. Returns the category name it picked
 * (a "parent > child" answer is reduced to the child).
 */
export async function categorize(description: string, apiUrl: string): Promise<string | null> {
  try {
    // every description is sent there: https only (or this computer), no credentials in the URL
    assertSafeCategoryUrl(apiUrl);
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`Category API error: ${res.status}`);
      return null;
    }

    const data = await res.json() as { text?: string; category?: string };
    const answer = (data.category ?? data.text ?? '').trim().replace(/^["'״]+|["'״.]+$/g, '');
    return answer ? answer.split('>').at(-1)!.trim() : null;
  } catch (err) {
    console.error('Category API failed:', err);
    return null;
  }
}
