export type Illustration = { src: string; width: number; height: number };
export type CharacterArt = { base: Illustration; basePortrait?: Illustration; elite2?: Illustration; elite2Portrait?: Illustration; generic?: boolean };
type IllustrationIndex = { version: number; people: Record<string, CharacterArt> };

let pending: Promise<IllustrationIndex> | null = null;

export function loadIllustrations(): Promise<IllustrationIndex> {
  if (!pending) {
    pending = fetch('/illustrations/index.json', { cache: 'no-cache' }).then(async response => {
      if (!response.ok) throw new Error('Illustration index unavailable');
      const result = await response.json() as IllustrationIndex;
      if (result.version !== 1 || !result.people || typeof result.people !== 'object') {
        throw new Error('Invalid illustration index');
      }
      return result;
    }).catch(error => { pending = null; throw error; });
  }
  return pending;
}
