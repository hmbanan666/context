declare module "snowball-stemmers-js" {
  export function newStemmer(language: "english" | "russian"): {
    stemWord(word: string): string;
  };
}
