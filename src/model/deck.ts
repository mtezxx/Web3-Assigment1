import { Shuffler } from '../utils/random_utils'

export type Color = 'BLUE' | 'GREEN' | 'RED' | 'YELLOW';
export const colors: ReadonlyArray<Color> = ['BLUE', 'GREEN', 'RED', 'YELLOW'] as const;

export type Type =
  | 'NUMBERED'
  | 'SKIP'
  | 'REVERSE'
  | 'DRAW'
  | 'WILD'
  | 'WILD DRAW';

export type NumberedCard = { type: 'NUMBERED'; color: Color; number: 0|1|2|3|4|5|6|7|8|9 };
export type SkipCard     = { type: 'SKIP';     color: Color };
export type ReverseCard  = { type: 'REVERSE';  color: Color };
export type DrawTwoCard  = { type: 'DRAW';     color: Color };
export type WildCard     = { type: 'WILD' };
export type WildDrawCard = { type: 'WILD DRAW' };

export type Card =
  | NumberedCard
  | SkipCard
  | ReverseCard
  | DrawTwoCard
  | WildCard
  | WildDrawCard;

export interface Deck {
  readonly size: number;
  deal(): Card | undefined;
  shuffle(shuffler: (cards: Card[]) => void): void;  // <- mutating, returns void
  filter(pred: (c: Card) => boolean): Deck;
  toMemento(): Record<string, string | number>[];
}

export function hasColor(card: Card, color: Color): boolean {
  return 'color' in card && card.color === color;
}
export function hasNumber(card: Card, n: number): boolean {
  return card.type === 'NUMBERED' && card.number === n;
}

/** Build a standard UNO deck (108 cards) in canonical order. */
export function createInitialDeck(): Deck {
  const list: Card[] = [];

  for (const color of colors) {
    // one zero
    list.push({ type: 'NUMBERED', color, number: 0 });
    // two of each 1..9
    for (let n = 1 as 1; n <= 9; n++) {
      const num = n as 1|2|3|4|5|6|7|8|9;
      list.push({ type: 'NUMBERED', color, number: num });
      list.push({ type: 'NUMBERED', color, number: num });
    }
    // actions: two per color
    list.push({ type: 'SKIP', color }, { type: 'SKIP', color });
    list.push({ type: 'REVERSE', color }, { type: 'REVERSE', color });
    list.push({ type: 'DRAW', color }, { type: 'DRAW', color });
  }

  // wilds
  list.push({ type: 'WILD' }, { type: 'WILD' }, { type: 'WILD' }, { type: 'WILD' });
  list.push(
    { type: 'WILD DRAW' }, { type: 'WILD DRAW' },
    { type: 'WILD DRAW' }, { type: 'WILD DRAW' },
  );

  return new ArrayDeck(list);
}

/** Create a Deck from a “memento” (plain objects). */
export function fromMemento(m: Record<string, string | number>[]): Deck {
  const list: Card[] = m.map((raw, i) => {
    const type = raw.type as Type | undefined;
    switch (type) {
      case 'NUMBERED': {
        const color = raw.color as Color | undefined;
        const number = raw.number as number | undefined;
        if (color === undefined || number === undefined) throw new Error(`Invalid NUMBERED at ${i}`);
        if (number < 0 || number > 9) throw new Error(`Illegal number ${number} at ${i}`);
        return { type, color, number: number as NumberedCard['number'] };
      }
      case 'SKIP':
      case 'REVERSE':
      case 'DRAW': {
        const color = raw.color as Color | undefined;
        if (!color) throw new Error(`Missing color for ${type} at ${i}`);
        return { type, color } as SkipCard | ReverseCard | DrawTwoCard;
      }
      case 'WILD':
        return { type };
      case 'WILD DRAW':
        return { type };
      default:
        throw new Error(`Unknown type at ${i}`);
    }
  });
  return new ArrayDeck(list);
}

class ArrayDeck implements Deck {
  private cards: Card[];
  constructor(cards: Card[]) { this.cards = [...cards]; }

  get size() { return this.cards.length; }

  deal(): Card | undefined {
    return this.cards.shift();
  }

  // before: took ReadonlyArray and replaced with returned array
  shuffle(shuffler: (cards: Card[]) => void): void {
    // Pass the internal array so the shuffler mutates it in place
    shuffler(this.cards);
  }

  filter(pred: (c: Card) => boolean): Deck {
    return new ArrayDeck(this.cards.filter(pred));
  }

  toMemento(): Record<string, string | number>[] {
    return this.cards.map(c => ({ ...c }));
  }
}
