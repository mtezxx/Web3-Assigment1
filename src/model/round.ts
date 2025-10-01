import { Card, Deck, createInitialDeck, Color } from './deck'
import { Shuffler } from '../utils/random_utils'

export interface DiscardPile {
  readonly size: number
  top(): Card | undefined
  add(card: Card): void
  add(card: Card, color: Color): void
}

export interface Round {
  readonly playerCount: number
  readonly dealer: number
  player(index: number): string
  playerHand(index: number): readonly Card[]
  playerInTurn(): number | undefined
  drawPile(): Deck
  discardPile(): DiscardPile
  canPlay(cardIndex: number): boolean
  canPlayAny(): boolean
  canDraw(): boolean
  play(cardIndex: number, color?: Color): Card
  draw(): Card
  score(): number | undefined
  catchUnoFailure(args: { accuser: number; accused: number }): boolean
  toMemento(): any
  sayUno(playerIndex: number): void
  onEnd(callback: (result: any) => void): void
  hasEnded(): boolean
  winner(): number | undefined
}

export interface RoundMemento {
  players: string[]
  dealer: number
  playerHands: Card[][]
  drawPile: any[]
  discardPile: any[]
  currentPlayer: number
  direction: number
  topCardColor: Color | undefined
}

class DeckImpl implements Deck {
  private cards: Card[]

  constructor(cards: Card[]) {
    this.cards = [...cards]
  }

  get size(): number {
    return this.cards.length
  }

  deal(): Card | undefined {
    return this.cards.shift()
  }

  peek(): Card | undefined {
    return this.cards[0]
  }

  add(card: Card): void {
    this.cards.push(card)
  }

  filter(predicate: (card: Card) => boolean): Deck {
    const filteredCards = this.cards.filter(predicate)
    return new DeckImpl(filteredCards)
  }

  shuffle(shuffler: Shuffler<Card>): void {
    shuffler(this.cards)
  }

  toMemento(): any[] {
    return this.cards.map(card => ({ ...card }))
  }

  getAllCards(): Card[] {
    return [...this.cards]
  }
}

class DiscardPileImpl implements DiscardPile {
  private cards: Card[] = []
  private currentColor: Color | undefined

  get size(): number {
    return this.cards.length
  }

  top(): Card | undefined {
    return this.cards.length > 0 ? this.cards[this.cards.length - 1] : undefined
  }

  add(card: Card, color?: Color): void {
    this.cards.push(card)
    
    if (color) {
      this.currentColor = color
    } else if ('color' in card) {
      this.currentColor = card.color
    }
  }

  getCurrentColor(): Color | undefined {
    return this.currentColor
  }

  toMemento(): any[] {
    return this.cards.map(card => ({ ...card }))
  }

  isEmpty(): boolean {
    return this.cards.length === 0
  }
}

class RoundImpl implements Round {
  private players: string[]
  readonly dealer: number
  private playerHands: Card[][]
  private currentPlayer: number
  private direction: number = 1
  private drawPileImpl: DeckImpl
  private discardPileImpl: DiscardPileImpl
  private unoDeclarations: Set<number> = new Set()
  private endCallbacks: ((result: any) => void)[] = []
  private finished: boolean = false
  private roundScore: number | undefined
  private readonly shuffler: Shuffler<Card>
  private lastActionTurn: number | undefined
  private actionCounter: number = 0
  private pendingUno?: { accused: number; actionId: number }
  private preUnoByAction?: { player: number; actionId: number }

  constructor(
    players: string[],
    dealer: number,
    shuffler: Shuffler<Card>,
    cardsPerPlayer: number = 7
  ) {
    if (players.length < 2) {
      throw new Error('At least 2 players are required')
    }
    if (players.length > 10) {
      throw new Error('At most 10 players are allowed')
    }
    const normalizedDealer = ((dealer % players.length) + players.length) % players.length

    this.players = [...players]
    this.dealer = normalizedDealer
    this.currentPlayer = (normalizedDealer + 1) % players.length
    this.shuffler = shuffler

    const deck = createInitialDeck()
    const deckImpl = deck as any
    const cards = deckImpl.cards
    shuffler(cards)
    this.drawPileImpl = new DeckImpl(cards)

    this.playerHands = new Array(players.length).fill(null).map(() => [])
    for (let p = 0; p < players.length; p++) {
      for (let i = 0; i < cardsPerPlayer; i++) {
        const card = this.drawPileImpl.deal()
        if (card) this.playerHands[p].push(card)
      }
    }

    this.discardPileImpl = new DiscardPileImpl()
    let topCard: Card | undefined
    do {
      topCard = this.drawPileImpl.deal()
      if (topCard && (topCard.type === 'WILD' || topCard.type === 'WILD DRAW')) {
        this.drawPileImpl.add(topCard)
        const allCards = this.drawPileImpl.getAllCards()
        shuffler(allCards)
        this.drawPileImpl = new DeckImpl(allCards)
      }
    } while (topCard && (topCard.type === 'WILD' || topCard.type === 'WILD DRAW'))

    if (topCard) {
      this.discardPileImpl.add(topCard)
      
      if (topCard.type === 'REVERSE') {
        this.direction = -1
        this.currentPlayer = (normalizedDealer - 1 + players.length) % players.length
      } else if (topCard.type === 'SKIP') {
        this.currentPlayer = (normalizedDealer + 2) % players.length
      } else if (topCard.type === 'DRAW') {
        const nextPlayer = (normalizedDealer + 1) % players.length
        this.drawCardsForPlayer(nextPlayer, 2)
        this.currentPlayer = (normalizedDealer + 2) % players.length
      }
    }
  }

  get playerCount(): number {
    return this.players.length
  }

  player(index: number): string {
    if (index < 0 || index >= this.players.length) {
      throw new Error('Player index out of bounds')
    }
    return this.players[index]
  }

  playerHand(index: number): readonly Card[] {
    return this.playerHands[index]
  }

  playerInTurn(): number | undefined {
    return this.finished ? undefined : this.currentPlayer
  }

  drawPile(): Deck {
    return this.drawPileImpl
  }

  discardPile(): DiscardPile {
    return this.discardPileImpl
  }

  canPlay(cardIndex: number): boolean {
    if (this.finished) return false
    
    const hand = this.playerHands[this.currentPlayer]
    if (cardIndex < 0 || cardIndex >= hand.length) return false

    const card = hand[cardIndex]
    const topCard = this.discardPileImpl.top()
    const currentColor = this.discardPileImpl.getCurrentColor()

    if (!topCard) return false

    if (card.type === 'WILD') return true

    if (card.type === 'WILD DRAW') {
      return !hand.some((c, i) => i !== cardIndex && this.cardMatchesColor(c, currentColor))
    }

    if ('color' in card && currentColor && card.color === currentColor) return true
    if (card.type === 'NUMBERED' && topCard.type === 'NUMBERED') {
      return card.number === topCard.number || card.color === topCard.color
    }
    if ((card.type === 'SKIP' || card.type === 'REVERSE' || card.type === 'DRAW')) {
      if (topCard.type === card.type) return true
      if ('color' in topCard && card.color === topCard.color) return true
      return false
    }

    return false
  }

  private cardMatchesColor(card: Card, color: Color | undefined): boolean {
    if (!color) return false
    if ('color' in card) return card.color === color
    return false
  }

  canPlayAny(): boolean {
    if (this.finished) return false
    
    const hand = this.playerHands[this.currentPlayer]
    return hand.some((_, index) => this.canPlay(index))
  }

  canDraw(): boolean {
    return !this.finished && this.drawPileImpl.size > 0
  }

  play(cardIndex: number, color?: Color): Card {
    this.startAction(this.currentPlayer)
    if (!this.canPlay(cardIndex)) {
      throw new Error('Illegal play')
    }

    const hand = this.playerHands[this.currentPlayer]
    const card = hand.splice(cardIndex, 1)[0]

    if (card.type === 'WILD' || card.type === 'WILD DRAW') {
      if (!color) {
        throw new Error('Wild card requires color selection')
      }
      this.discardPileImpl.add(card, color)
    } else {
      if (color) {
        throw new Error('Color can only be named on wild cards')
      }
      this.discardPileImpl.add(card)
    }

    const cur = this.currentPlayer
    if (hand.length === 1) {
      if (this.preUnoByAction && this.preUnoByAction.player === cur && this.preUnoByAction.actionId === this.actionCounter) {
        this.preUnoByAction = undefined
      } else {
        this.pendingUno = { accused: cur, actionId: this.actionCounter }
      }
    }
    this.lastActionTurn = this.currentPlayer

    this.handleSpecialCard(card)

    this.nextPlayer()

    if (hand.length === 0) {
      this.finishRound()
      return card
    }

    return card
  }

  private handleSpecialCard(card: Card): void {
    switch (card.type) {
      case 'SKIP':
        this.nextPlayer()
        break
      case 'REVERSE':
        this.direction *= -1
        if (this.playerCount === 2) {
          this.nextPlayer()
        }
        break
      case 'DRAW':
        this.nextPlayer()
        this.drawCardsForPlayer(this.currentPlayer, 2)
        break
      case 'WILD DRAW':
        this.nextPlayer()
        this.drawCardsForPlayer(this.currentPlayer, 4)
        break
    }
  }

  private nextPlayer(): void {
    this.currentPlayer = (this.currentPlayer + this.direction + this.playerCount) % this.playerCount
  }

  private drawCardsForPlayer(playerIndex: number, count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.drawPileImpl.size === 0) {
        this.reshuffleDiscardPile()
      }
      const card = this.drawPileImpl.deal()
      if (card) {
        this.playerHands[playerIndex].push(card)
      }
    }
  }

  draw(): Card {
    this.startAction(this.currentPlayer)
    if (!this.canDraw()) {
      throw new Error('Cannot draw')
    }

    if (this.drawPileImpl.size === 0) {
      this.reshuffleDiscardPile()
    }

    const card = this.drawPileImpl.deal()
    if (card) {
      const cur = this.currentPlayer
      this.playerHands[cur].push(card)
      const wasPlayable = this.canPlay(this.playerHands[cur].length - 1)
      if (!wasPlayable) this.nextPlayer()
      if (this.drawPileImpl.size === 0) {
        this.reshuffleDiscardPile()
      }
      return card
    }
    throw new Error('No cards available')
  }

  private startAction(actor: number): void {
    if (this.pendingUno && actor !== this.pendingUno.accused) {
      this.pendingUno = undefined
    }
    this.actionCounter++
  }

  private reshuffleDiscardPile(): void {
    const discardCards = this.discardPileImpl.toMemento()
    if (discardCards.length <= 1) return
    const topCardData = discardCards.pop()!
    const moved: Card[] = discardCards.map(c => this.createCardFromData(c))
    this.shuffler(moved)
    for (const c of moved) this.drawPileImpl.add(c)
    const prevColor = this.discardPileImpl.getCurrentColor()
    this.discardPileImpl = new DiscardPileImpl()
    const recreatedTop = this.createCardFromData(topCardData)
    if (prevColor && recreatedTop.type !== 'WILD' && recreatedTop.type !== 'WILD DRAW') {
      this.discardPileImpl.add(recreatedTop)
    } else if (prevColor) {
      this.discardPileImpl.add(recreatedTop, prevColor)
    } else {
      this.discardPileImpl.add(recreatedTop)
    }
  }

  private createCardFromData(cardData: any): Card {
    if (cardData.type === 'NUMBERED') {
      return { type: 'NUMBERED', color: cardData.color, number: cardData.number }
    } else if (['SKIP', 'REVERSE', 'DRAW'].includes(cardData.type)) {
      return { type: cardData.type, color: cardData.color }
    } else {
      return { type: cardData.type }
    }
  }

  score(): number | undefined {
    return this.roundScore
  }

  catchUnoFailure(args: { accuser: number; accused: number }): boolean {
    if (this.finished) return false
    const { accuser, accused } = args
    if (accused < 0 || accused >= this.playerCount) throw new Error('Accused out of bounds')
    if (accuser < 0 || accuser >= this.playerCount) throw new Error('Accuser out of bounds')
    const window = this.pendingUno
    if (!window || window.accused !== accused) return false
    const accusedHand = this.playerHands[accused]
    if (accusedHand.length !== 1) return false
    this.drawCardsForPlayer(accused, 4)
    this.pendingUno = undefined
    return true
  }

  sayUno(playerIndex: number): void {
    if (this.finished) {
      throw new Error('Round has ended')
    }
    if (playerIndex < 0 || playerIndex >= this.playerCount) {
      throw new Error('Player index out of bounds')
    }
    if (this.pendingUno && this.pendingUno.accused === playerIndex && this.pendingUno.actionId === this.actionCounter) {
      this.pendingUno = undefined
      return
    }
    if (playerIndex === this.currentPlayer) {
      this.preUnoByAction = { player: playerIndex, actionId: this.actionCounter + 1 }
      return
    }
  }

  onEnd(callback: (result: any) => void): void {
    this.endCallbacks.push(callback)
  }

  private finishRound(): void {
    this.finished = true
    this.roundScore = this.calculateScore()
    
    const winner = this.getWinner()
    const result = winner === -1 ? {} : { winner }
    
    this.endCallbacks.forEach(callback => callback(result))
  }

  private getWinner(): number {
    for (let i = 0; i < this.playerHands.length; i++) {
      if (this.playerHands[i].length === 0) {
        return i
      }
    }
    return -1
  }

  private calculateScore(): number {
    let score = 0
    for (let i = 0; i < this.playerHands.length; i++) {
      if (this.playerHands[i].length > 0) {
        for (const card of this.playerHands[i]) {
          switch (card.type) {
            case 'NUMBERED':
              score += card.number
              break
            case 'SKIP':
            case 'REVERSE':
            case 'DRAW':
              score += 20
              break
            case 'WILD':
            case 'WILD DRAW':
              score += 50
              break
          }
        }
      }
    }
    return score
  }

  toMemento(): any {
    const discardBottomToTop = this.discardPileImpl.toMemento()
    const discardTopFirst = [...discardBottomToTop].reverse()
    return {
      players: [...this.players],
      hands: this.playerHands.map(hand => [...hand]),
      drawPile: this.drawPileImpl.toMemento().map(cardData => {
        if (cardData.type === 'NUMBERED') {
          return { type: cardData.type as 'NUMBERED', color: cardData.color as Color, number: cardData.number as number }
        } else if (['SKIP', 'REVERSE', 'DRAW'].includes(cardData.type as string)) {
          return { type: cardData.type as 'SKIP' | 'REVERSE' | 'DRAW', color: cardData.color as Color }
        } else {
          return { type: cardData.type as 'WILD' | 'WILD DRAW' }
        }
      }),
      discardPile: discardTopFirst,
      currentColor: this.discardPileImpl.getCurrentColor(),
      currentDirection: this.direction > 0 ? 'clockwise' : 'counterclockwise',
      dealer: this.dealer,
      playerInTurn: this.finished ? undefined : this.currentPlayer
    }
  }

  hasEnded(): boolean { return this.finished }
  winner(): number | undefined { const w = this.getWinner(); return w === -1 ? undefined : w }
}

export function createRound(config: {
  players: string[]
  dealer: number
  shuffler?: Shuffler<Card>
  cardsPerPlayer?: number
}): Round {
  return new RoundImpl(
    config.players,
    config.dealer,
    config.shuffler || ((cards: Card[]) => {}),
    config.cardsPerPlayer
  )
}

export function createRoundFromMemento(
  memento: any,
  shuffler?: Shuffler<Card>
): Round {
  if (!memento.players || memento.players.length < 2) {
    throw new Error('Invalid memento: need at least 2 players')
  }
  
  const handsArr: any[] | undefined = memento.hands || memento.playerHands
  if (!handsArr || handsArr.length !== memento.players.length) {
    throw new Error('Invalid memento: hands count mismatch')
  }
  
  if (!memento.discardPile || memento.discardPile.length === 0) {
    throw new Error('Invalid memento: empty discard pile')
  }
  
  if (memento.dealer < 0 || memento.dealer >= memento.players.length) {
    throw new Error('Invalid memento: dealer out of bounds')
  }
  
  if (memento.playerInTurn !== undefined && (memento.playerInTurn < 0 || memento.playerInTurn >= memento.players.length)) {
    throw new Error('Invalid memento: playerInTurn out of bounds')
  }
  
  if (memento.currentColor && !['RED', 'BLUE', 'GREEN', 'YELLOW'].includes(memento.currentColor)) {
    throw new Error('Invalid memento: invalid currentColor')
  }
  const mTop = memento.discardPile[0]
  if (mTop) {
    if (mTop.type === 'NUMBERED' || mTop.type === 'SKIP' || mTop.type === 'REVERSE' || mTop.type === 'DRAW') {
      if (memento.currentColor && mTop.color !== memento.currentColor) {
        throw new Error('Invalid memento: inconsistent currentColor')
      }
    } else {
      if (!memento.currentColor) {
        throw new Error('Invalid memento: wild top requires currentColor')
      }
    }
  }
  
  const emptyHands = handsArr.filter((hand: any[]) => hand.length === 0).length
  if (emptyHands > 1) {
    throw new Error('Invalid memento: multiple winners')
  }
  
  const isFinished = emptyHands === 1
  if (!isFinished && memento.playerInTurn === undefined) {
    throw new Error('Invalid memento: playerInTurn required for unfinished game')
  }

  const normalizedMemento: RoundMemento = {
    players: memento.players,
    dealer: memento.dealer,
    playerHands: handsArr,
    drawPile: memento.drawPile,
    discardPile: memento.discardPile,
    currentPlayer: memento.playerInTurn !== undefined ? memento.playerInTurn : memento.currentPlayer,
    direction: memento.currentDirection === 'clockwise' ? 1 : -1,
    topCardColor: memento.currentColor
  }

  const round = new RoundImpl(normalizedMemento.players, normalizedMemento.dealer, () => {})
  const roundImpl = round as any
  roundImpl.shuffler = shuffler || (() => {})
  roundImpl.playerHands = normalizedMemento.playerHands.map((hand: Card[]) => [...hand])
  roundImpl.currentPlayer = normalizedMemento.currentPlayer
  roundImpl.direction = normalizedMemento.direction
  
  const drawPileCards = normalizedMemento.drawPile.map((cardData: any) => {
    if (cardData.type === 'NUMBERED') {
      return { type: 'NUMBERED' as const, color: cardData.color as Color, number: cardData.number as number }
    } else if (['SKIP', 'REVERSE', 'DRAW'].includes(cardData.type)) {
      return { type: cardData.type as 'SKIP' | 'REVERSE' | 'DRAW', color: cardData.color as Color }
    } else {
      return { type: cardData.type as 'WILD' | 'WILD DRAW' }
    }
  })
  roundImpl.drawPileImpl = new DeckImpl(drawPileCards as Card[])
  
  roundImpl.discardPileImpl = new DiscardPileImpl()
  for (let i = normalizedMemento.discardPile.length - 1; i >= 0; i--) {
    const cardData = normalizedMemento.discardPile[i]
    const card = roundImpl.createCardFromData(cardData)
    roundImpl.discardPileImpl.add(card)
  }
  
  if (normalizedMemento.topCardColor) {
    roundImpl.discardPileImpl.currentColor = normalizedMemento.topCardColor
  }
  
  if (isFinished) {
    roundImpl.finished = true
    roundImpl.roundScore = roundImpl.calculateScore()
  }

  return round
}