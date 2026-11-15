// Synthetic noise for the mixed grounding eval. A few hundred notes mention
// weather, Paris, recipes, and the 2018 world cup often enough that those
// words are common, sometimes in one sentence and sometimes far apart.
// Distinctive curated names and the rare off-topic words are absent.

export interface DistractorNote {
  readonly path: string;
  readonly markdown: string;
}

const filler =
  "Deploy queue drained after the health check. Latency stayed under forty milliseconds. Сборка зелёная, очередь пустая, журнал хоста без ошибок.";

function pad(value: number): string {
  return String(value).padStart(3, "0");
}

function gap(): string {
  return Array.from({ length: 12 }, () => filler).join("\n\n");
}

function note(path: string, title: string, body: string): DistractorNote {
  return {
    path,
    markdown: `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`,
  };
}

export function distractorNotes(): DistractorNote[] {
  const notes: DistractorNote[] = [];
  for (let index = 1; index <= 36; index += 1) {
    notes.push(
      note(
        `weather-split-${pad(index)}.md`,
        `Heartbeat ${pad(index)}`,
        `Weather bot heartbeat ${index}.\n\n${gap()}\n\nCDN pop ${index} is Paris. Париж указан как имя узла ${index}.`,
      ),
    );
  }
  for (let index = 1; index <= 48; index += 1) {
    notes.push(
      note(
        `weather-together-${pad(index)}.md`,
        `Webhook ${pad(index)}`,
        `The weather bot ${index} tagged Paris in the webhook payload and stored the weather icon. Погода и Париж здесь только имена бота ${index}, без прогноза.`,
      ),
    );
  }
  for (let index = 1; index <= 48; index += 1) {
    notes.push(
      note(
        `recipe-asset-${pad(index)}.md`,
        `Catalog image ${pad(index)}`,
        `Catalog image asset recipe-borscht-${index}.png. Рецепт борща is an image asset ${index}, not a method. The borscht recipe file is a png asset in the catalog.`,
      ),
    );
  }
  for (let index = 1; index <= 48; index += 1) {
    notes.push(
      note(
        `sports-together-${pad(index)}.md`,
        `Broadcast ${pad(index)}`,
        `Broadcast log ${index} from 2018 mentioned a world cup final and a penalty review. No score is stored. The filename is world-cup-2018-final-penalty-${index}.txt.`,
      ),
    );
  }
  for (let index = 1; index <= 24; index += 1) {
    notes.push(
      note(
        `sports-split-${pad(index)}.md`,
        `Review queue ${pad(index)}`,
        `Penalty review queued for log ${index}.\n\n${gap()}\n\nThe 2018 world cup filename ${index} has no score.`,
      ),
    );
  }
  for (let index = 1; index <= 96; index += 1) {
    notes.push(
      note(
        `dev-log-${pad(index)}.md`,
        `Deploy note ${pad(index)}`,
        `Deploy note ${index}. ${filler}`,
      ),
    );
  }
  const boosts = [
    "weather feed",
    "Paris CDN",
    "погода",
    "Париж",
    "recipe file",
    "borscht png",
    "рецепт",
    "борщ",
    "world label",
    "cup label",
    "2018 label",
    "final label",
    "penalty label",
    "image label",
    "asset label",
  ];
  for (let index = 1; index <= 36; index += 1) {
    const label = boosts[(index - 1) % boosts.length] ?? "label";
    notes.push(
      note(
        `mixed-tech-${pad(index)}.md`,
        `Tech note ${pad(index)}`,
        `Mixed RU/EN tech note ${index} records a ${label}. ${filler}`,
      ),
    );
  }
  return notes;
}
