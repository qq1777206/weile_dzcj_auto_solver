/**
 * dzcj_bot.js — 斗地主残局自动解题器
 *
 * 基于 card_win_solver.py 的命令行前端
 * 支持交互式输入和单次命令行模式
 *
 * 用法:
 *   node dzcj_bot.js                                # 交互模式
 *   node dzcj_bot.js --mine "大王2AKQJ109" --opponent "8765"  # 单次求解
 *   node dzcj_bot.js --hand "D2AKQJ1098876654433"   # 测试手牌
 */

const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

// ===== 牌面编码转换 =====
// solver RANKS = ["3","4","5","6","7","8","9","10","J","Q","K","A","2","X","D"]
const RANK_NAMES_CN = {
  '3':'3', '4':'4', '5':'5', '6':'6', '7':'7', '8':'8', '9':'9',
  '10':'10', 'J':'J', 'Q':'Q', 'K':'K', 'A':'A', '2':'2', 'X':'小王', 'D':'大王',
};
const CN_TO_RANK = {
  '3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9',
  '10':'10','J':'j','Q':'q','K':'k','A':'a','2':'2',
  '小王':'X','大王':'D','x':'X','d':'D',
};

/**
 * 标准化用户输入的手牌文本
 * 支持中文: "大王2AKQJ109876543" 或 "小王AAKQJ1098876655"
 * 支持英文: "D2AKQJ109876543" 或 "XAAKQJ1098876655"
 */
function normalizeInput(text) {
  let s = text.trim().replace(/\s+/g, '');
  // 替换中文
  s = s.replace(/大王/g, 'D').replace(/小王/g, 'X');
  s = s.replace(/[aA]/g, 'A').replace(/[jJ]/g, 'J')
       .replace(/[qQ]/g, 'Q').replace(/[kK]/g, 'K');
  return s.toUpperCase();
}

// ===== 求解器调用 =====
function callSolver(mine, opponent, first, trick) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join(__dirname, 'card_win_solver.py'),
      '--mine', mine,
      '--opponent', opponent,
      '--first', first || 'me',
    ];
    if (trick) {
      args.push('--trick', trick);
    }
    const py = spawn('python', args);
    let out = '', err = '';
    py.stdout.on('data', d => out += d);
    py.stderr.on('data', d => err += d);
    py.on('close', code => {
      if (code !== 0) return reject(new Error('求解器异常退出 ' + code + ': ' + err));
      resolve(out);
    });
    py.on('error', reject);
  });
}

/**
 * 牌面文本美化（机器文本 → 中文显示）
 */
function prettyCardText(text) {
  if (text === 'PASS') return '不出';
  return text.replace(/D/g, '大王').replace(/X/g, '小王');
}

/**
 * 解析求解器输出并格式化显示
 * 通过 __RESULT__ 行进行机器可读解析（避免编码问题）
 */
function formatSolverOutput(raw) {
  const result = { canWin: false, suggestion: '', suggestionRaw: '', detail: [] };

  // 解析 __RESULT__ 行
  const resMatch = raw.match(/__RESULT__\s+can_win=(\S+)\s+suggestion=(\S+)/);
  if (resMatch) {
    result.canWin = resMatch[1] === 'true';
    result.suggestionRaw = resMatch[2];
    result.suggestion = prettyCardText(resMatch[2]);
  }

  // 提取首手评估行 (以 - 开头的行)
  const evalMatch = raw.match(/首手评估:\n([\s\S]*?)(?=\n\n|\n一条|$)/);
  if (evalMatch) {
    result.detail = evalMatch[1].split('\n')
      .map(l => l.trim()).filter(l => l.startsWith('-'));
  }

  return result;
}

function printResult(raw, simple) {
  const parsed = formatSolverOutput(raw);
  if (simple) {
    console.log(parsed.canWin ? '✅ 可强制获胜' : '❌ 无法强制获胜');
    console.log('建议出牌:', parsed.suggestion);
    return;
  }
  // 完整模式: 显示主要信息
  const lines = raw.split('\n').filter(l => l.trim());
  for (const line of lines) {
    // 跳过 __RESULT__ 行（已解析）
    if (line.startsWith('__RESULT__')) continue;
    // 跳过纯分隔线
    if (/^[=]+$/.test(line.trim())) continue;
    console.log(line);
  }
  // 补充解析结果
  console.log(`→ 结论: ${parsed.canWin ? '✅ 可强制获胜' : '❌ 无法强制获胜'}`);
  console.log(`→ 建议出牌: ${parsed.suggestion}`);
}

// ===== 交互模式 =====
async function interactiveMode() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = q => new Promise(r => rl.question(q, r));

  console.log('=== 斗地主残局自动解题器 ===');
  console.log('输入牌面文本，支持格式: D2AKQJ109876543 (D=大王 X=小王)');
  console.log('也支持中文: 大王2AKQJ109876543');
  console.log('输入 q 退出');
  console.log('');

  try {
    const mineRaw = await prompt('我方手牌: ');
    if (mineRaw.toLowerCase() === 'q') { rl.close(); return; }
    const mine = normalizeInput(mineRaw);
    if (!mine) { console.log('手牌不能为空'); rl.close(); return; }

    const oppRaw = await prompt('对方手牌: ');
    if (oppRaw.toLowerCase() === 'q') { rl.close(); return; }
    const opponent = normalizeInput(oppRaw);
    if (!opponent) { console.log('手牌不能为空'); rl.close(); return; }

    const firstRaw = await prompt('先手方 (me/对手，默认 me): ');
    const first = firstRaw.trim().toLowerCase() === '对手' ? 'opponent' : 'me';

    const trickRaw = await prompt('当前牌型/管牌 (没有则直接回车): ');
    const trick = trickRaw ? normalizeInput(trickRaw) : '';

    console.log('\n求解中...\n');
    const result = await callSolver(mine, opponent, first, trick);
    printResult(result, false);

  } catch (e) {
    console.error('错误:', e.message);
  }

  rl.close();
}

// ===== 命令行模式 =====
function cliMode(args) {
  const mine = normalizeInput(args.mine || '');
  const opponent = normalizeInput(args.opponent || '');
  const first = args.first === 'opponent' ? 'opponent' : 'me';
  const trick = args.trick ? normalizeInput(args.trick) : '';
  const simple = args.simple || false;

  if (!mine || !opponent) {
    console.error('请指定 --mine 和 --opponent');
    process.exit(1);
  }

  callSolver(mine, opponent, first, trick)
    .then(result => printResult(result, simple))
    .catch(e => { console.error('错误:', e.message); process.exit(1); });
}

// ===== 入口 =====
function main() {
  const args = process.argv.slice(2);

  // 解析命令行参数
  const parsed = {};
  for (const a of args) {
    if (a.startsWith('--mine=')) parsed.mine = a.slice('--mine='.length);
    else if (a.startsWith('--opponent=')) parsed.opponent = a.slice('--opponent='.length);
    else if (a.startsWith('--first=')) parsed.first = a.slice('--first='.length);
    else if (a.startsWith('--trick=')) parsed.trick = a.slice('--trick='.length);
    else if (a === '--simple') parsed.simple = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法:');
      console.log('  node dzcj_bot.js                          # 交互模式');
      console.log('  node dzcj_bot.js --mine="手牌" --opponent="手牌"  # 命令行模式');
      console.log('');
      console.log('参数:');
      console.log('  --mine=文本     我方手牌 (如 "大王2AKQJ109876543")');
      console.log('  --opponent=文本 对方手牌 (如 "小王AAKQJ1098876655")');
      console.log('  --first=me/对手 先手方，默认 me');
      console.log('  --trick=文本    当前桌面牌型（管牌场景）');
      console.log('  --simple        简洁输出');
      console.log('  --help          帮助');
      console.log('');
      console.log('代理自动模式:');
      console.log('  node wss_proxy_poker.js wss://服务器:端口 --auto');
      return;
    }
  }

  if (parsed.mine && parsed.opponent) {
    cliMode(parsed);
  } else if (args.length === 0) {
    interactiveMode();
  } else {
    console.log('请指定 --mine 和 --opponent，或直接运行进入交互模式');
    console.log('使用 --help 查看帮助');
  }
}

if (require.main === module) main();
module.exports = { normalizeInput, callSolver, formatSolverOutput };
