import { Shuffler, standardShuffler } from '../utils/random_utils';
import * as deck from './deck';
import type { Card, Color } from './uno';
import { canPlay } from './uno';

export type Direction = 1 | -1;
export type DirectionLabel = 'clockwise' | 'counterclockwise';

export type RoundMemento = {
	players: string[];
	hands: Card[][];
	drawPile: Card[];
	discardPile: Card[];
	currentColor: Color;
	currentDirection: DirectionLabel;
	dealer: number;
	playerInTurn?: number;
};

export interface Round {
	readonly playerCount: number;
	readonly dealer: number;
	player(index: number): string;
	playerHand(index: number): Card[];
	drawPile(): deck.Deck & { peek(): Card | undefined };
	discardPile(): deck.Deck & { top(): Card | undefined };
	playerInTurn(): number | undefined;
	play(cardIndex: number, color?: Color): Card;
	draw(): Card;
	canPlay(cardIndex: number): boolean;
	canPlayAny(): boolean;
	catchUnoFailure(args: { accuser: number; accused: number }): boolean;
	sayUno(playerIndex: number): void;
	hasEnded(): boolean;
	winner(): number | undefined;
	score(): number | undefined;
	onEnd(handler: (event: { winner: number }) => void): void;
	toMemento(): RoundMemento;
}

export type RoundConfig = {
	players: string[];
	dealer: number;
	cardsPerPlayer?: number;
	shuffler?: Shuffler<Card>;
};

export function createRound(config: RoundConfig): Round {
	const players = config.players ?? [];
	validatePlayers(players);
	const cardsPerPlayer = config.cardsPerPlayer ?? 7;
	if (cardsPerPlayer <= 0) throw new Error('cardsPerPlayer must be positive');
	ensureIndex(config.dealer, players.length, 'dealer');
	const shuffler = config.shuffler ?? standardShuffler;

	const setup = buildInitialState(players, config.dealer, cardsPerPlayer, shuffler);

	return new RoundImpl({
		players,
		dealer: config.dealer,
		hands: setup.hands,
		drawPile: setup.drawPile,
		discardPile: setup.discardPile,
		currentPlayer: setup.currentPlayer,
		direction: setup.direction,
		enforcedColor: setup.enforcedColor,
		shuffler,
	});
}

export function createRoundFromMemento(
	memento: RoundMemento,
	shuffler: Shuffler<Card> = standardShuffler,
): Round {
	const { players, dealer, currentDirection, currentColor } = memento;
	validatePlayers(players);
	ensureIndex(dealer, players.length, 'dealer');

	const direction = toDirection(currentDirection);
	const normalizedColor = ensureColorValue(currentColor);

	if (memento.hands.length !== players.length) {
		throw new Error('Hands count must equal players count');
	}

	const hands = memento.hands.map(cloneCardsWithValidation);
	const drawPile = cloneCardsWithValidation(memento.drawPile);
	const discardPile = cloneCardsWithValidation(memento.discardPile);

	if (discardPile.length === 0) {
		throw new Error('Discard pile cannot be empty');
	}

	const winners = hands.reduce<number[]>((acc, hand, index) => {
		if (hand.length === 0) acc.push(index);
		return acc;
	}, []);
	if (winners.length > 1) {
		throw new Error('Round memento cannot contain multiple winners');
	}
	const finished = winners.length === 1;

	let currentPlayer = memento.playerInTurn;
	if (finished) {
		currentPlayer = undefined;
	} else {
		if (currentPlayer === undefined) {
			throw new Error('playerInTurn is required for unfinished rounds');
		}
		ensureIndex(currentPlayer, players.length, 'playerInTurn');
	}

	const top = discardPile[discardPile.length - 1];
	let enforcedColor: Color | undefined;
	if (top.type === 'WILD' || top.type === 'WILD DRAW') {
		enforcedColor = normalizedColor;
	} else {
		if (!('color' in top) || top.color !== normalizedColor) {
			throw new Error('currentColor must match the color of the top discard');
		}
	}

	return new RoundImpl({
		players,
		dealer,
		hands,
		drawPile,
		discardPile,
		currentPlayer,
		direction,
		enforcedColor,
		shuffler,
	});
}

type RoundState = {
	players: string[];
	dealer: number;
	hands: Card[][];
	drawPile: Card[];
	discardPile: Card[];
	direction: Direction;
	currentPlayer?: number;
	enforcedColor?: Color;
	shuffler: Shuffler<Card>;
};

class RoundImpl implements Round {
	readonly playerCount: number;
	readonly dealer: number;

	private readonly players: string[];
	private readonly shuffler: Shuffler<Card>;
	private readonly listeners: Array<(event: { winner: number }) => void> = [];
	private readonly unoDeclared: boolean[];

	private hands: Card[][];
	private drawPileCards: Card[];
	private discardPileCards: Card[];
	private direction: Direction;
	private currentPlayerIndex: number | undefined;
	private enforcedColor?: Color;
	private pendingUno?: { player: number; windowOpen: boolean };

	private ended = false;
	private winnerIndex?: number;
	private cachedScore?: number;

	constructor(state: RoundState) {
		this.players = [...state.players];
		this.playerCount = this.players.length;
		this.dealer = state.dealer;
		this.hands = state.hands.map(hand => [...hand]);
		this.drawPileCards = [...state.drawPile];
		this.discardPileCards = [...state.discardPile];
		this.direction = state.direction;
		this.currentPlayerIndex = state.currentPlayer;
		this.enforcedColor = state.enforcedColor;
		this.shuffler = state.shuffler;
		this.unoDeclared = new Array(this.playerCount).fill(false);

		if (this.discardPileCards.length === 0) {
			throw new Error('Discard pile cannot be empty');
		}

		const winners = this.hands.reduce<number[]>((acc, hand, index) => {
			if (hand.length === 0) acc.push(index);
			return acc;
		}, []);

		if (winners.length > 1) {
			throw new Error('Round cannot be initialised with multiple winners');
		}

		if (winners.length === 1) {
			this.ended = true;
			this.winnerIndex = winners[0];
			this.currentPlayerIndex = undefined;
		} else if (this.currentPlayerIndex === undefined) {
			throw new Error('playerInTurn must be defined for an unfinished round');
		}
	}

	player(index: number): string {
		this.ensurePlayerIndex(index);
		return this.players[index];
	}

	playerHand(index: number): Card[] {
		this.ensurePlayerIndex(index);
		return this.hands[index];
	}

	drawPile(): deck.Deck & { peek(): Card | undefined } {
		return new DrawPileView(this.drawPileCards);
	}

	discardPile(): deck.Deck & { top(): Card | undefined } {
		return new DiscardPileView(this.discardPileCards);
	}

	playerInTurn(): number | undefined {
		return this.currentPlayerIndex;
	}

	play(cardIndex: number, color?: Color): Card {
		this.ensureActiveRound();
		const current = this.ensureCurrentPlayer();
		this.ensureCardIndex(current, cardIndex);
		this.markActionBy(current);

		const hand = this.hands[current];
		const card = hand[cardIndex];

		if (!this.canPlay(cardIndex)) {
			throw new Error('Card cannot be played');
		}

		hand.splice(cardIndex, 1);
		this.discardPileCards.push(card);

		if (card.type === 'WILD' || card.type === 'WILD DRAW') {
			if (!color) throw new Error('Color must be specified when playing a wild card');
			this.enforcedColor = ensureColorValue(color);
		} else {
			if (color) throw new Error('Color can only be provided for wild cards');
			this.enforcedColor = undefined;
		}

		let advanceSteps = 1;

		switch (card.type) {
			case 'SKIP':
				advanceSteps = 2;
				break;
			case 'REVERSE':
				if (this.playerCount === 2) {
					advanceSteps = 2;
					this.direction = (this.direction * -1) as Direction;
				} else {
					this.direction = (this.direction * -1) as Direction;
					advanceSteps = 1;
				}
				break;
			case 'DRAW': {
				const victim = this.nextIndexFromCurrent(1);
				this.applyPenalty(victim, 2);
				this.markActionBy(victim);
				advanceSteps = 2;
				break;
			}
			case 'WILD':
				advanceSteps = 1;
				break;
			case 'WILD DRAW': {
				const victim = this.nextIndexFromCurrent(1);
				this.applyPenalty(victim, 4);
				this.markActionBy(victim);
				advanceSteps = 2;
				break;
			}
			default:
				advanceSteps = 1;
		}

		this.updateUnoStateFor(current);

		if (hand.length === 0) {
			this.pendingUno = undefined;
			this.finishRound(current);
			return card;
		}

		if (!this.ended) {
			this.advance(advanceSteps);
		}

		return card;
	}

	draw(): Card {
		this.ensureActiveRound();
		const current = this.ensureCurrentPlayer();
		this.markActionBy(current);

		const card = this.takeFromDrawPile();
		this.hands[current].push(card);
		this.updateUnoStateFor(current);

		if (!canPlay(card, this.topCard(), this.enforcedColor)) {
			this.advance(1);
		}

		return card;
	}

	canPlay(cardIndex: number): boolean {
		if (this.ended) return false;
		const current = this.currentPlayerIndex;
		if (current === undefined) return false;
		const hand = this.hands[current];
		if (cardIndex < 0 || cardIndex >= hand.length) return false;
		return canPlay(hand[cardIndex], this.topCard(), this.enforcedColor);
	}

	canPlayAny(): boolean {
		if (this.ended) return false;
		const current = this.currentPlayerIndex;
		if (current === undefined) return false;
		const hand = this.hands[current];
		return hand.some(card => canPlay(card, this.topCard(), this.enforcedColor));
	}

	catchUnoFailure({ accuser, accused }: { accuser: number; accused: number }): boolean {
		this.ensurePlayerIndex(accuser);
		this.ensurePlayerIndex(accused);

		if (!this.pendingUno) return false;
		if (this.pendingUno.player !== accused) return false;
		if (!this.pendingUno.windowOpen) return false;
		if (this.unoDeclared[accused]) return false;

		const hand = this.hands[accused];
		if (hand.length !== 1) return false;

		this.pendingUno = undefined;
		this.applyPenalty(accused, 4);
		this.unoDeclared[accused] = false;
		return true;
	}

	sayUno(playerIndex: number): void {
		this.ensurePlayerIndex(playerIndex);
		if (this.ended) throw new Error('Round has finished');

		const handSize = this.hands[playerIndex].length;
		if (handSize > 2) {
			throw new Error('UNO can only be declared with two or fewer cards');
		}

		this.unoDeclared[playerIndex] = true;
		if (this.pendingUno && this.pendingUno.player === playerIndex) {
			this.pendingUno = undefined;
		}
	}

	hasEnded(): boolean {
		return this.ended;
	}

	winner(): number | undefined {
		return this.winnerIndex;
	}

	score(): number | undefined {
		if (!this.ended) return undefined;
		if (this.winnerIndex === undefined) return undefined;
		if (this.cachedScore === undefined) {
			this.cachedScore = this.computeScore(this.winnerIndex);
		}
		return this.cachedScore;
	}

	onEnd(handler: (event: { winner: number }) => void): void {
		if (this.ended && this.winnerIndex !== undefined) {
			handler({ winner: this.winnerIndex });
		} else {
			this.listeners.push(handler);
		}
	}

	toMemento(): RoundMemento {
		return {
			players: [...this.players],
			hands: this.hands.map(hand => hand.map(cloneCard)),
			drawPile: this.drawPileCards.map(cloneCard),
			discardPile: this.discardPileCards.map(cloneCard),
			currentColor: this.currentColor(),
			currentDirection: this.direction === 1 ? 'clockwise' : 'counterclockwise',
			dealer: this.dealer,
			playerInTurn: this.ended ? undefined : this.currentPlayerIndex,
		};
	}

	private ensureActiveRound(): void {
		if (this.ended) throw new Error('Round has finished');
	}

	private ensurePlayerIndex(index: number): void {
		ensureIndex(index, this.playerCount, 'player');
	}

	private ensureCardIndex(player: number, cardIndex: number): void {
		const hand = this.hands[player];
		if (cardIndex < 0 || cardIndex >= hand.length) {
			throw new Error('Card index out of bounds');
		}
	}

	private ensureCurrentPlayer(): number {
		if (this.currentPlayerIndex === undefined) {
			throw new Error('No player currently in turn');
		}
		return this.currentPlayerIndex;
	}

	private topCard(): Card {
		return this.discardPileCards[this.discardPileCards.length - 1];
	}

	private currentColor(): Color {
		if (this.enforcedColor) return this.enforcedColor;
		const top = this.topCard();
		if ('color' in top) {
			return top.color as Color;
		}
		throw new Error('Current color is undefined');
	}

	private markActionBy(player: number): void {
		if (this.pendingUno && this.pendingUno.player !== player) {
			this.pendingUno.windowOpen = false;
		}
	}

	private updateUnoStateFor(player: number): void {
		const handSize = this.hands[player].length;

		if (handSize === 1) {
			if (!this.unoDeclared[player]) {
				this.pendingUno = { player, windowOpen: true };
			} else if (this.pendingUno && this.pendingUno.player === player) {
				this.pendingUno = undefined;
			}
		} else {
			this.unoDeclared[player] = false;
			if (this.pendingUno && this.pendingUno.player === player) {
				this.pendingUno = undefined;
			}
		}

		if (this.pendingUno && this.hands[this.pendingUno.player].length !== 1) {
			this.pendingUno = undefined;
		}
	}

	private applyPenalty(player: number, cards: number): void {
		this.drawCardsForPlayer(player, cards);
		this.updateUnoStateFor(player);
	}

	private drawCardsForPlayer(player: number, count: number): void {
		const hand = this.hands[player];
		for (let i = 0; i < count; i++) {
			hand.push(this.takeFromDrawPile());
		}
	}

	private takeFromDrawPile(): Card {
		if (this.drawPileCards.length === 0) {
			this.refillDrawPile();
		}
		const card = this.drawPileCards.shift();
		if (!card) {
			throw new Error('No cards available to draw');
		}
		return card;
	}

	private refillDrawPile(): void {
		if (this.drawPileCards.length > 0) return;
		if (this.discardPileCards.length <= 1) {
			throw new Error('Cannot replenish draw pile');
		}

		const top = this.discardPileCards[this.discardPileCards.length - 1];
		const rest = this.discardPileCards.slice(0, -1).map(cloneCard);
		this.drawPileCards = rest;
		this.discardPileCards = [top];
		this.shuffler(this.drawPileCards);
	}

	private advance(steps: number): void {
		if (this.currentPlayerIndex === undefined) return;
		const next = this.currentPlayerIndex + steps * this.direction;
		this.currentPlayerIndex = mod(next, this.playerCount);
	}

	private nextIndexFromCurrent(offset: number): number {
		const current = this.ensureCurrentPlayer();
		return mod(current + offset * this.direction, this.playerCount);
	}

	private finishRound(winner: number): void {
		if (this.ended) return;
		this.ended = true;
		this.winnerIndex = winner;
		this.currentPlayerIndex = undefined;
		this.cachedScore = this.computeScore(winner);
		for (const listener of this.listeners) {
			listener({ winner });
		}
	}

	private computeScore(winner: number): number {
		return this.hands.reduce((total, hand, index) => {
			if (index === winner) return total;
			return total + hand.reduce((subtotal, card) => subtotal + cardPoints(card), 0);
		}, 0);
	}
}

class DrawPileView implements deck.Deck {
	constructor(private readonly pile: Card[]) {}

	get size(): number {
		return this.pile.length;
	}

	deal(): Card | undefined {
		return this.pile.shift();
	}

	shuffle(shuffler: (cards: Card[]) => void): void {
		shuffler(this.pile);
	}

	filter(pred: (c: Card) => boolean): deck.Deck {
		return deck.fromMemento(this.pile.filter(pred).map(serialize));
	}

	toMemento(): Record<string, string | number>[] {
		return this.pile.map(serialize);
	}

	peek(): Card | undefined {
		return this.pile[0];
	}
}

class DiscardPileView implements deck.Deck {
	constructor(private readonly pile: Card[]) {}

	get size(): number {
		return this.pile.length;
	}

	deal(): Card | undefined {
		return this.pile.shift();
	}

	shuffle(shuffler: (cards: Card[]) => void): void {
		shuffler(this.pile);
	}

	filter(pred: (c: Card) => boolean): deck.Deck {
		return deck.fromMemento(this.pile.filter(pred).map(serialize));
	}

	toMemento(): Record<string, string | number>[] {
		return this.pile.map(serialize);
	}

	top(): Card | undefined {
		return this.pile[this.pile.length - 1];
	}
}

type InitialState = {
	hands: Card[][];
	drawPile: Card[];
	discardPile: Card[];
	currentPlayer: number;
	direction: Direction;
	enforcedColor?: Color;
};

function buildInitialState(
	players: string[],
	dealer: number,
	cardsPerPlayer: number,
	shuffler: Shuffler<Card>,
): InitialState {
	while (true) {
		const deckInstance = deck.createInitialDeck();
		deckInstance.shuffle(shuffler);

		const cards: Card[] = [];
		while (deckInstance.size > 0) {
			const next = deckInstance.deal();
			if (next) cards.push(next);
		}

		const hands = players.map(() => [] as Card[]);
		for (let i = 0; i < cardsPerPlayer; i++) {
			for (let p = 0; p < players.length; p++) {
				const card = cards.shift();
				if (!card) throw new Error('Deck exhausted while dealing');
				hands[p].push(card);
			}
		}

		const firstDiscard = cards.shift();
		if (!firstDiscard) throw new Error('Deck exhausted before drawing discard card');
		if (firstDiscard.type === 'WILD' || firstDiscard.type === 'WILD DRAW') {
			continue;
		}

		const discardPile = [firstDiscard];
		let direction: Direction = 1;
		let currentPlayer = mod(dealer + 1, players.length);
		let enforcedColor: Color | undefined;

		switch (firstDiscard.type) {
			case 'SKIP':
				currentPlayer = mod(dealer + 2, players.length);
				break;
			case 'REVERSE':
				if (players.length === 2) {
					direction = -1;
					currentPlayer = dealer;
				} else {
					direction = -1;
					currentPlayer = mod(dealer - 1, players.length);
				}
				break;
			case 'DRAW': {
				const victim = currentPlayer;
				drawIntoHand(hands[victim], cards, 2);
				currentPlayer = mod(dealer + 2, players.length);
				break;
			}
			default:
				break;
		}

		return {
			hands,
			drawPile: cards,
			discardPile,
			currentPlayer,
			direction,
			enforcedColor,
		};
	}
}

function drawIntoHand(hand: Card[], source: Card[], count: number): void {
	for (let i = 0; i < count; i++) {
		const next = source.shift();
		if (!next) throw new Error('Deck exhausted while resolving draw effect');
		hand.push(next);
	}
}

function validatePlayers(players: string[]): void {
	if (players.length < 2) throw new Error('A round requires at least two players');
	if (players.length > 10) throw new Error('A round supports at most ten players');
}

function ensureIndex(index: number, count: number, label: string): void {
	if (!Number.isInteger(index)) throw new Error(`${label} must be an integer`);
	if (index < 0 || index >= count) throw new Error(`${label} is out of bounds`);
}

function toDirection(label: DirectionLabel): Direction {
	if (label === 'clockwise') return 1;
	if (label === 'counterclockwise') return -1;
	throw new Error(`Unknown direction: ${label}`);
}

function ensureColorValue(value: string | Color): Color {
	const color = value as Color;
	if (!deck.colors.includes(color)) {
		throw new Error(`Invalid color: ${value}`);
	}
	return color;
}

function cloneCardsWithValidation(cards: Card[]): Card[] {
	const serialized = cards.map(serialize);
	const validated = deck.fromMemento(serialized);
	const result: Card[] = [];
	while (validated.size > 0) {
		const card = validated.deal();
		if (card) result.push(card);
	}
	return result;
}

function cloneCard(card: Card): Card {
	return { ...card } as Card;
}

function serialize(card: Card): Record<string, string | number> {
	return { ...card } as Record<string, string | number>;
}

function mod(value: number, modulus: number): number {
	const result = value % modulus;
	return result >= 0 ? result : result + modulus;
}

function cardPoints(card: Card): number {
	switch (card.type) {
		case 'NUMBERED':
			return card.number;
		case 'SKIP':
		case 'REVERSE':
		case 'DRAW':
			return 20;
		case 'WILD':
		case 'WILD DRAW':
			return 50;
		default:
			return 0;
	}
}

