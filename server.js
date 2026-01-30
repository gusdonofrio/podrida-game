const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const STATE_FILE = './podrida_state.json';
const HANDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const CARD_RANK = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };
const SUIT_ORDER = { '♠': 0, '♥': 1, '♣': 2, '♦': 3 };

let game = {
    seatedPlayers: [],
    bids: {},
    tricksWon: {},
    scores: {},
    history: [],
    currentHandIndex: 0,
    turnIndex: 0,
    trumpCard: null,
    isHandInProgress: false,
    cardsOnTable: [],
    lastTrick: null
};

// --- RECOVERY LOGIC ---
function saveState() {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(game)); } catch(e) { console.error("Save error", e); }
}

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const data = fs.readFileSync(STATE_FILE);
            const saved = JSON.parse(data);
            Object.assign(game, saved);
            console.log(">>> Partida restaurada desde el archivo.");
        } catch(e) { console.log("No se pudo cargar el estado previo."); }
    }
}
loadState();

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
    socket.emit('init-lobby', game);

    socket.on('select-player', (nickname) => {
        let existing = game.seatedPlayers.find(p => p.nickname === nickname);
        if (existing) {
            existing.id = socket.id; // Reconnect existing player
        } else if (game.seatedPlayers.length < 5 && !game.isHandInProgress) {
            game.seatedPlayers.push({ nickname, id: socket.id, seatIndex: game.seatedPlayers.length });
            game.scores[nickname] = game.scores[nickname] || { points: 0, fallas: 0 };
        }
        io.emit('update-table', game);
        saveState();
    });

    socket.on('start-game', () => {
        if (game.seatedPlayers.length < 5 || game.isHandInProgress) return;
        game.isHandInProgress = true;
        game.bids = {}; game.tricksWon = {}; game.cardsOnTable = []; game.lastTrick = null;
        game.seatedPlayers.forEach(p => game.tricksWon[p.nickname] = 0);
        
        game.turnIndex = (game.currentHandIndex + 1) % 5;
        const suits = ['♠', '♥', '♣', '♦'], vals = Object.keys(CARD_RANK);
        let deck = []; suits.forEach(s => vals.forEach(v => deck.push({s, v})));
        deck.sort(() => Math.random() - 0.5);

        const cardCount = HANDS[game.currentHandIndex];
        game.seatedPlayers.forEach(p => {
            p.hand = deck.splice(0, cardCount).sort((a,b) => (SUIT_ORDER[a.s] - SUIT_ORDER[b.s]) || (CARD_RANK[a.v] - CARD_RANK[b.v]));
        });
        game.trumpCard = deck.pop();
        
        let label = (game.currentHandIndex >= 10 && game.currentHandIndex <= 12) ? "sin triunfo" : (game.currentHandIndex > 12 ? "bajando" : "subiendo");
        io.emit('game-started', { ...game, handNumber: cardCount, handLabel: label, dealer: game.seatedPlayers[game.currentHandIndex % 5].nickname, nextPlayer: game.seatedPlayers[game.turnIndex].nickname });
        saveState();
    });

    socket.on('submit-bid', (data) => {
        if (game.seatedPlayers[game.turnIndex].nickname !== data.nickname) return;
        game.bids[data.nickname] = data.bid;
        game.turnIndex = (game.turnIndex + 1) % 5;
        const bidsCount = Object.keys(game.bids).length;
        if (bidsCount === 5) {
            game.turnIndex = (game.currentHandIndex % 5 + 1) % 5;
            io.emit('bids-complete', { bids: game.bids, nextPlayer: game.seatedPlayers[game.turnIndex].nickname });
        } else {
            let forbidden = (bidsCount === 4) ? (HANDS[game.currentHandIndex] - Object.values(game.bids).reduce((a, b) => a + b, 0)) : null;
            io.emit('bid-update', { bids: game.bids, nextPlayer: game.seatedPlayers[game.turnIndex].nickname, forbiddenBid: forbidden, handSize: HANDS[game.currentHandIndex] });
        }
    });

    socket.on('play-card', (data) => {
        const p = game.seatedPlayers[game.turnIndex];
        // --- DEBUG LOG ---
        console.log(`[PLAY] ${data.nickname} intentó jugar ${data.card.v}${data.card.s}. Turno actual: ${p.nickname}`);

        if (!p || data.nickname !== p.nickname) return;
        
        // Anti-Renuncio
        if (game.cardsOnTable.length > 0) {
            const leadingSuit = game.cardsOnTable[0].card.s;
            if (data.card.s !== leadingSuit && p.hand.some(c => c.s === leadingSuit)) {
                socket.emit('error-msg', `¡Renuncio! Tenés que tirar ${leadingSuit}.`);
                return;
            }
        }

        p.hand = p.hand.filter(c => !(c.v === data.card.v && c.s === data.card.s));
        game.cardsOnTable.push({ nickname: p.nickname, card: data.card, seatIndex: p.seatIndex });
        game.turnIndex = (game.turnIndex + 1) % 5;
        
        io.emit('card-played', { playedCard: data.card, playerNickname: p.nickname, playerSeat: p.seatIndex, nextPlayer: game.seatedPlayers[game.turnIndex].nickname });

        if (game.cardsOnTable.length === 5) {
            const winner = determineWinner(game.cardsOnTable, game.trumpCard, game.currentHandIndex);
            game.tricksWon[winner.nickname]++;
            game.lastTrick = [...game.cardsOnTable];
            game.turnIndex = game.seatedPlayers.find(sp => sp.nickname === winner.nickname).seatIndex;

            setTimeout(() => {
                game.cardsOnTable = [];
                const totalTricks = Object.values(game.tricksWon).reduce((a, b) => a + b, 0);
                const handDone = totalTricks === HANDS[game.currentHandIndex];
                io.emit('clear-felt', { winner: winner.nickname, nextPlayer: game.seatedPlayers[game.turnIndex].nickname, tricksWon: game.tricksWon, lastTrick: game.lastTrick, handFinished: handDone });
                if (handDone) finishHand();
            }, 2500);
        }
    });

    socket.on('chat-msg', (data) => io.emit('chat-msg', data));
});

function determineWinner(cards, trump, handIdx) {
    const leadSuit = cards[0].card.s;
    const isSinTriunfo = (handIdx >= 10 && handIdx <= 12);
    let win = cards[0];
    for(let i=1; i<5; i++){
        const c = cards[i];
        const cIsT = !isSinTriunfo && c.card.s === trump.s;
        const wIsT = !isSinTriunfo && win.card.s === trump.s;
        if(cIsT && !wIsT) win = c;
        else if(cIsT && wIsT) { if(CARD_RANK[c.card.v] > CARD_RANK[win.card.v]) win = c; }
        else if(!cIsT && !wIsT && c.card.s === leadSuit) { if(CARD_RANK[c.card.v] > CARD_RANK[win.card.v]) win = c; }
    }
    return win;
}

function finishHand() {
    let rec = { handNum: game.currentHandIndex + 1, cardCount: HANDS[game.currentHandIndex], results: {} };
    game.seatedPlayers.forEach(p => {
        const bid = game.bids[p.nickname], won = game.tricksWon[p.nickname];
        let pts = (bid === won) ? (10 + (won * 5)) : (1 * won);
        if (bid !== won) game.scores[p.nickname].fallas++;
        game.scores[p.nickname].points += pts;
        rec.results[p.nickname] = { pts, total: game.scores[p.nickname].points, falla: (bid !== won), won, bid };
    });
    game.history.push(rec);
    game.currentHandIndex++;
    game.isHandInProgress = false;
    io.emit('hand-finished', { scores: game.scores, history: game.history, currentHandIndex: game.currentHandIndex, lastHandResult: rec });
    saveState();
}

http.listen(PORT, '0.0.0.0', () => console.log("Server Live with Recovery Enabled"));
