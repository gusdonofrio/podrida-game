const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = process.env.PORT || 3000;
const HANDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const CARD_RANK = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };
const SUIT_ORDER = { '♠': 0, '♥': 1, '♣': 2, '♦': 3 };

let seatedPlayers = [];
let bids = {}; 
let tricksWon = {}; 
let scores = {}; 
let history = []; 
let cardsOnTable = []; 
let lastTrick = null;
let currentHandIndex = 0;
let turnIndex = 0; 
let trumpCard = null;
let isHandInProgress = false;

const players = [
    { name: "Rodolfo D'Onofrio", nickname: "Bucéfalo", gender: "M" },
    { name: "Dila D'Onofrio", nickname: "Dila", gender: "F" },
    { name: "Maximiliano D'Onofrio", nickname: "Maxi", gender: "M" },
    { name: "Federico D'Onofrio", nickname: "Fido Dido", gender: "M" },
    { name: "Fatima D'Onofrio", nickname: "Fatima", gender: "F" },
    { name: "Martina D'Onofrio", nickname: "Marti", gender: "F" },
    { name: "Agustin D'Onofrio", nickname: "Agus", gender: "M" },
    { name: "Nicolas D'Onofrio", nickname: "Atila", gender: "M" },
    { name: "Lucia D'Onofrio", nickname: "Luchi", gender: "F" },
    { name: "Matilda D'Onofrio", nickname: "Tilly", gender: "F" },
    { name: "Emilia D'Onofrio", nickname: "Emi Pig", gender: "F" },
    { name: "Rodrigo", nickname: "Rodri", gender: "M" },
    { name: "Paula Iocco", nickname: "Pau", gender: "F" },
    { name: "Felipe D'Onofrio", nickname: "Felipe", gender: "M" },
    { name: "Mateo D'Onofrio", nickname: "Mateo", gender: "M" },
    { name: "Tahiel D'Onofrio", nickname: "Tahiel", gender: "M" },
    { name: "Benjamin D'Onofrio", nickname: "Gaznápiro", gender: "M" },
    { name: "Camila", nickname: "Cami", gender: "F" }
];

function determineWinner(cards, trump, handIdx) {
    const isSinTriunfo = (handIdx >= 10 && handIdx <= 12);
    const leadingSuit = cards[0].card.s;
    let winner = cards[0];
    for (let i = 1; i < cards.length; i++) {
        const current = cards[i];
        const curIsT = (!isSinTriunfo && current.card.s === trump.s);
        const winIsT = (!isSinTriunfo && winner.card.s === trump.s);
        if (curIsT && !winIsT) winner = current;
        else if (curIsT && winIsT) { if (CARD_RANK[current.card.v] > CARD_RANK[winner.card.v]) winner = current; }
        else if (!curIsT && !winIsT) { if (current.card.s === leadingSuit && CARD_RANK[current.card.v] > CARD_RANK[winner.card.v]) winner = current; }
    }
    return winner;
}

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
    socket.emit('init-lobby', { players, seatedPlayers, scores, history, currentHandIndex, isHandInProgress });

    socket.on('select-player', (nickname) => {
        if (seatedPlayers.length >= 5 || seatedPlayers.find(p => p.nickname === nickname)) return;
        const pData = players.find(p => p.nickname === nickname);
        seatedPlayers.push({...pData, id: socket.id});
        if (seatedPlayers.length === 5) {
            seatedPlayers = seatedPlayers.sort(() => Math.random() - 0.5);
            seatedPlayers.forEach((p, idx) => { p.seatIndex = idx; scores[p.nickname] = { points: 0, fallas: 0 }; });
        }
        io.emit('update-table', { seatedPlayers, scores, history, currentHandIndex, isHandInProgress });
    });

    socket.on('chat-msg', (data) => {
        io.emit('chat-msg', { nick: data.nick, msg: data.msg });
    });

    socket.on('start-game', () => {
        if (seatedPlayers.length < 5 || isHandInProgress) return;
        isHandInProgress = true;
        bids = {}; tricksWon = {}; cardsOnTable = []; lastTrick = null;
        seatedPlayers.forEach(p => tricksWon[p.nickname] = 0);
        const dealerIdx = currentHandIndex % 5;
        turnIndex = (dealerIdx + 1) % 5; 
        
        const suits = ['♠', '♥', '♣', '♦'];
        const vals = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
        let deck = [];
        suits.forEach(s => vals.forEach(v => deck.push({s, v})));
        deck.sort(() => Math.random() - 0.5);

        const cardCount = HANDS[currentHandIndex];
        let label = (currentHandIndex >= 10 && currentHandIndex <= 12) ? "sin triunfo" : (currentHandIndex > 12 ? "bajando" : "subiendo");

        seatedPlayers.forEach(p => {
            let hand = deck.splice(0, cardCount);
            hand.sort((a, b) => {
                if (SUIT_ORDER[a.s] !== SUIT_ORDER[b.s]) return SUIT_ORDER[a.s] - SUIT_ORDER[b.s];
                return CARD_RANK[a.v] - CARD_RANK[b.v];
            });
            p.hand = hand;
        });
        trumpCard = deck.pop();
        io.emit('game-started', { handNumber: cardCount, handLabel: label, players: seatedPlayers, trump: trumpCard, dealer: seatedPlayers[dealerIdx].nickname, nextPlayer: seatedPlayers[turnIndex].nickname });
    });

    socket.on('submit-bid', (data) => {
        if (seatedPlayers[turnIndex].nickname !== data.nickname) return;
        bids[data.nickname] = data.bid;
        turnIndex = (turnIndex + 1) % 5;
        const bidsCount = Object.keys(bids).length;
        if (bidsCount === 5) {
            turnIndex = (currentHandIndex % 5 + 1) % 5;
            io.emit('bids-complete', { bids, nextPlayer: seatedPlayers[turnIndex].nickname });
        } else {
            let forbidden = (bidsCount === 4) ? (HANDS[currentHandIndex] - Object.values(bids).reduce((a, b) => a + b, 0)) : null;
            io.emit('bid-update', { bids, nextPlayer: seatedPlayers[turnIndex].nickname, forbiddenBid: forbidden, handSize: HANDS[currentHandIndex] });
        }
    });

    socket.on('play-card', (data) => {
        const p = seatedPlayers[turnIndex];
        if (!p || data.nickname !== p.nickname) return;
        
        // Suit enforce
        if (cardsOnTable.length > 0) {
            const leadingSuit = cardsOnTable[0].card.s;
            if (data.card.s !== leadingSuit && p.hand.some(c => c.s === leadingSuit)) {
                socket.emit('error-msg', "Carta no autorizada. No podes renunciar.");
                return;
            }
        }

        p.hand = p.hand.filter(c => !(c.v === data.card.v && c.s === data.card.s));
        cardsOnTable.push({ nickname: p.nickname, card: data.card, seatIndex: p.seatIndex });
        turnIndex = (turnIndex + 1) % 5;
        io.emit('card-played', { playedCard: data.card, playerNickname: p.nickname, playerSeat: p.seatIndex, nextPlayer: seatedPlayers[turnIndex].nickname, totalOnTable: cardsOnTable.length });

        if (cardsOnTable.length === 5) {
            const winner = determineWinner(cardsOnTable, trumpCard, currentHandIndex);
            tricksWon[winner.nickname]++;
            lastTrick = [...cardsOnTable];
            turnIndex = seatedPlayers.find(sp => sp.nickname === winner.nickname).seatIndex;
            setTimeout(() => {
                cardsOnTable = [];
                io.emit('clear-felt', { winner: winner.nickname, nextPlayer: seatedPlayers[turnIndex].nickname, tricksWon, lastTrick });
                if (Object.values(tricksWon).reduce((a, b) => a + b, 0) === HANDS[currentHandIndex]) calculateScores();
            }, 2500);
        }
    });

    socket.on('disconnect', () => {
        seatedPlayers = seatedPlayers.filter(p => p.id !== socket.id);
        io.emit('update-table', { seatedPlayers, scores, history, currentHandIndex, isHandInProgress });
    });
});

function calculateScores() {
    isHandInProgress = false;
    let handRecord = { handNum: currentHandIndex + 1, cardCount: HANDS[currentHandIndex], results: {} };
    seatedPlayers.forEach(p => {
        const bid = bids[p.nickname], won = tricksWon[p.nickname];
        let ptsGained = (bid === won) ? (10 + (won * 5)) : (1 * won);
        if (bid !== won) scores[p.nickname].fallas++;
        scores[p.nickname].points += ptsGained;
        handRecord.results[p.nickname] = { pts: ptsGained, total: scores[p.nickname].points, bid: bid, won: won, falla: (bid !== won) };
    });
    history.push(handRecord);
    currentHandIndex++;
    if (currentHandIndex === 21) io.emit('tournament-complete', { scores, history });
    else io.emit('hand-finished', { scores, history, currentHandIndex, lastHandResult: handRecord });
}

http.listen(PORT, '0.0.0.0', () => console.log(`D'Onofrio Server Active`));
