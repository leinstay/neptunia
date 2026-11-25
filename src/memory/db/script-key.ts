// The key by which a name in Cyrillic letters and the same name in Latin letters compare equal. `scriptKey(word)` writes
// every letter of the Cyrillic alphabet as the Latin letters people type for it (`LATIN_OF`, one table of the alphabet)
// and leaves digits, Latin letters and everything else as they are, so "вокзал" and "vokzal" give one key and "3d" stays
// "3d". The table names no word. The name index (names.ts) keeps the key of each name's stems beside the stems and
// compares whole keys, never a prefix of one.
// Pure of the bot and of the database.

/** The Latin letters people type for each letter of the Russian, Ukrainian and Belarusian alphabets. */
const LATIN_OF: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  є: 'ye',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'yi',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ў: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** The key of a word or a phrase: lower case, each Cyrillic letter written as its Latin letters. */
export function scriptKey(word: string): string {
  let key = '';
  for (const letter of word.toLowerCase()) key += LATIN_OF[letter] ?? letter;
  return key;
}
