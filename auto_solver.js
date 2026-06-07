/**
 * auto_solver.js — 斗地主残局自动求解模块（去重版）
 *
 * 修复 bug: 服务器发送 0x0003(明文) + 0x03EB(zlib) 两个发牌包时，
 * 旧代码会触发两次求解，导致同一手牌打两次。
 *
 * 解决: 记录上次已处理的手牌指纹，相同指纹跳过。
 */

const path = require('path');
const { spawn } = require('child_process');
const zlib = require('zlib');

// 求解器 RANKS = ["3","4","5","6","7","8","9","10","J","Q","K","A","2","X","D"]
const SOLVER_CHARS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2','X','D'];
const SOLVER_MAP = { 1:11, 2:12, 3:0, 4:1, 5:2, 6:3, 7:4, 8:5, 9:6, 10:7, 11:8, 12:9, 13:10 };

class AutoSolver {
  constructor(solverScriptPath) {
    this.solverScript = solverScriptPath;
    this.lastHandsKey = '';     // 去重指纹
    this.autoStep = 0;
    this.userId = null;
    this.currentUserId = null;
    this.sessionHead8_12 = Buffer.from([0xb3, 0xaa, 0x00, 0x00]);
    this.sessionField20_24 = Buffer.from([0xdd, 0x39, 0x00, 0x00]);
    this.onLog = null;          // 回调: (msg) => void
    this.onUpstreamSend = null; // 回调: (buf) => void
    this.firstHandSkipped = false; // 第一张只提示
  }

  log(msg) {
    if (this.onLog) this.onLog(msg);
  }

  /**
   * 从发牌包 body 中解析双方手牌
   * 支持明文和 zlib 压缩
   */
  /** 验证字节是否为合法卡牌值 */
  isValidCardByte(v) {
    if (v === 0x41 || v === 0x42) return true;
    const suit = (v >> 4) & 0x0F;
    const rank = v & 0x0F;
    return suit <= 3 && rank >= 1 && rank <= 13;
  }

  /** 一组字节是否全部合法 */
  allValidCards(cards) {
    for (const c of cards) {
      if (!this.isValidCardByte(c)) return false;
    }
    return true;
  }

  parseHands(body) {
    if (!body || body.length < 20) return null;
    let data = body;
    if (body[0] === 0x78 && (body[1] === 0x9c || body[1] === 0x01 || body[1] === 0xda || body[1] === 0x5e)) {
      try { data = zlib.inflateSync(body); } catch (e) { return null; }
    }

    // 方式1: 0x0003 格式 — 查找 02 02 [ourCnt] 00 [oppCnt] 00 00 标记
    for (let i = 0; i < data.length - 8; i++) {
      if (data[i] === 0x02 && data[i + 1] === 0x02) {
        const ourCnt = data[i + 2], oppCnt = data[i + 4];
        if (ourCnt < 1 || ourCnt > 27 || oppCnt < 1 || oppCnt > 27) continue;
        if (data[i + 3] !== 0x00) continue;
        const ourS = i + 7, oppS = ourS + ourCnt, oppE = oppS + oppCnt;
        if (oppE > data.length) continue;
        const ourCards = Buffer.from(data.slice(ourS, oppS));
        const oppCards = Buffer.from(data.slice(oppS, oppE));
        if (this.allValidCards(ourCards) && this.allValidCards(oppCards)) {
          return { ourCards, oppCards, ourCount: ourCnt, oppCount: oppCnt };
        }
      }
    }

    // 方式2: 0x000A/0x03ED 格式 — 查找 ff ff 分隔符后的手牌块
    for (let i = 0; i < data.length - 10; i++) {
      if (data[i] === 0xff && data[i + 1] === 0xff) {
        const cardStart = i + 6; // 跳过 ff ff 00 00 00 00
        if (cardStart + 4 >= data.length) continue;
        let j = cardStart;
        while (j < data.length && this.isValidCardByte(data[j])) j++;
        const ourCnt = j - cardStart;
        if (ourCnt < 2 || ourCnt > 27) continue;
        let k = j;
        while (k < data.length && !this.isValidCardByte(data[k])) k++;
        let oppEnd = k;
        while (oppEnd < data.length && this.isValidCardByte(data[oppEnd])) oppEnd++;
        const oppCnt = oppEnd - k;
        if (oppCnt < 1 || oppCnt > 27) continue;
        return {
          ourCards: Buffer.from(data.slice(cardStart, j)),
          oppCards: Buffer.from(data.slice(k, oppEnd)),
          ourCount: ourCnt, oppCount: oppCnt,
        };
      }
    }

    return null;
  }

  /**
   * 游戏牌字节 → 求解器文本
   */
  gameBytesToText(bytes) {
    const counts = {};
    for (const raw of bytes) {
      const val = typeof raw === 'number' ? raw : raw.valueOf();
      let idx;
      if (val === 0x41) idx = 13;       // 小王 → X
      else if (val === 0x42) idx = 14;  // 大王 → D
      else {
        const rank = val & 0x0F, suit = (val >> 4) & 0x0F;
        if (suit > 3 || rank < 1 || rank > 13) continue;
        idx = SOLVER_MAP[rank];
        if (idx === undefined) continue;
      }
      const ch = SOLVER_CHARS[idx];
      counts[ch] = (counts[ch] || 0) + 1;
    }
    let out = '';
    for (let i = 14; i >= 0; i--) {
      const ch = SOLVER_CHARS[i];
      if (counts[ch]) out += ch.repeat(counts[ch]);
    }
    return out;
  }

  /**
   * 生成手牌指纹（去重用）
   */
  handsKey(ourText, oppText) {
    return ourText + '|' + oppText;
  }

  /**
   * 调用求解器
   */
  callSolver(mine, opp) {
    return new Promise((resolve, reject) => {
      const py = spawn('python', [
        this.solverScript,
        '--mine', mine,
        '--opponent', opp,
      ]);
      let out = '', err = '';
      py.stdout.on('data', d => out += d);
      py.stderr.on('data', d => err += d);
      py.on('close', code => {
        if (code !== 0) return reject(new Error('求解器异常: ' + err));
        const m = out.match(/__RESULT__\s+can_win=(\S+)\s+suggestion=(\S+)/);
        if (!m) return reject(new Error('无法解析求解器输出'));
        resolve({ canWin: m[1] === 'true', suggestion: m[2] });
      });
      py.on('error', reject);
    });
  }

  /**
   * 将求解器建议的牌（如 "KKQQ"）转为游戏字节
   */
  suggestionToGameBytes(suggestion, ourCards) {
    // 出牌包编码: 0x10 | rank（固定 mei 花色）
    const result = [];

    const rankToGame = {
      '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
      '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 1, '2': 2, 'X': 0x41, 'D': 0x42,
    };

    let i = 0;
    while (i < suggestion.length) {
      let rankStr;
      if (suggestion[i] === '1' && i + 1 < suggestion.length && suggestion[i + 1] === '0') {
        rankStr = '10'; i += 2;
      } else {
        rankStr = suggestion[i]; i += 1;
      }

      const gameRank = rankToGame[rankStr];
      if (gameRank === undefined) continue;
      if (gameRank === 0x41 || gameRank === 0x42) {
        result.push(gameRank);
      } else {
        result.push(0x10 | gameRank);
      }
    }
    return result;
  }

  /**
   * 构建出牌包 (0x0006 旧格式)
   */
  buildPlayPkt(cards) {
    const total = 26 + cards.length * 2;
    const b = Buffer.alloc(total);
    b[0] = total & 0xff; b[1] = 0x00;
    b[2] = 0x06; b[3] = 0x00;
    b[4] = 0x00; b[5] = 0xc0; b[6] = 0x00; b[7] = 0x18;
    this.sessionHead8_12.copy(b, 8);
    b[12] = 0x00; b[13] = 0x00; b[14] = 0x00; b[15] = 0x00;
    if (this.currentUserId) this.currentUserId.copy(b, 16, 0, 4);
    this.sessionField20_24.copy(b, 20);
    b.writeUInt16LE(this.autoStep, 24);
    for (let i = 0; i < cards.length; i++) {
      b[26 + i * 2] = 0x01;
      b[27 + i * 2] = cards[i];
    }
    return b;
  }

  /**
   * 构建不出包 (0x0008)
   */
  buildPassPkt() {
    const b = Buffer.alloc(26);
    b[0] = 26; b[1] = 0x00;
    b[2] = 0x08; b[3] = 0x00;
    b[4] = 0x00; b[5] = 0xc0; b[6] = 0x00; b[7] = 0x18;
    this.sessionHead8_12.copy(b, 8);
    b[12] = 0x00; b[13] = 0x00; b[14] = 0x00; b[15] = 0x00;
    if (this.currentUserId) this.currentUserId.copy(b, 16, 0, 4);
    this.sessionField20_24.copy(b, 20);
    b.writeUInt16LE(this.autoStep, 24);
    return b;
  }

  cardLabel(v) {
    const SUIT_NAMES_CN = ['方片', '梅花', '红桃', '黑桃'];
    const RANK_NAMES = ['?', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    if (v === 0x42) return '大王';
    if (v === 0x41) return '小王';
    const suitIdx = (v >> 4) & 0x0F;
    const rankIdx = v & 0x0F;
    if (suitIdx > 3) return '0x' + v.toString(16);
    if (rankIdx < 1 || rankIdx > 13) return '0x' + v.toString(16);
    return '[' + SUIT_NAMES_CN[suitIdx] + RANK_NAMES[rankIdx] + ']';
  }

  /**
   * 尝试自动求解（带去重）
   * @param {Buffer} body 包体（offset 24 之后的数据）
   * @returns {boolean} 是否触发了解题
   */
  trySolve(body) {
    const hands = this.parseHands(body);
    if (!hands || hands.ourCount < 1 || hands.oppCount < 1) return false;

    const ourText = this.gameBytesToText(hands.ourCards);
    const oppText = this.gameBytesToText(hands.oppCards);
    if (!ourText || !oppText) return false;

    const key = this.handsKey(ourText, oppText);

    // === 去重：相同手牌不重复求解 ===
    if (key === this.lastHandsKey) {
      this.log('  ⏭️ [自动] 相同手牌，跳过重复求解');
      return false;
    }
    this.lastHandsKey = key;

    this.autoStep = 1;
    this.log(`\n🎯 [自动] 检测到手牌! 我方=${ourText} 对方=${oppText}`);

    this.callSolver(ourText, oppText).then(res => {
      this.log(`  🤖 求解器建议: ${res.suggestion}`);
      setTimeout(() => {
        if (!this.firstHandSkipped) {
          this.firstHandSkipped = true;
          this.log('  ⏸️ 第一张仅提示，请手动出牌。之后自动。');
          return;
        }
        if (res.suggestion === 'PASS') {
          const pkt = this.buildPassPkt();
          if (this.onUpstreamSend) this.onUpstreamSend(pkt);
          this.log(`  📤→S 不出 (step=${this.autoStep})`);
        } else {
          const playCards = this.suggestionToGameBytes(res.suggestion, hands.ourCards);
          if (playCards.length > 0) {
            const pkt = this.buildPlayPkt(playCards);
            if (this.onUpstreamSend) this.onUpstreamSend(pkt);
            this.log(`  📤→S 打出: ${playCards.map(v => this.cardLabel(v)).join(' ')} (step=${this.autoStep})`);
          }
        }
        this.autoStep++;
      }, 4000);
    }).catch(e => {
      this.log(`  ❌ 求解失败: ${e.message}`);
    });

    return true;
  }
}

module.exports = AutoSolver;
