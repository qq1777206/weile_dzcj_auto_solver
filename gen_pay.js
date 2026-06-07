/**
 * 支付请求参数生成器
 * 只需提供 userid、token、商品参数，自动补全并生成 sign
 */

const crypto = require('crypto');

function hex_md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }
function urlencode(s) { return encodeURIComponent(s); }

// 默认固定参数（从已确认请求中提取）
const DEFAULTS = {
  allow_skip: '0',
  appid: 'wxa27ca98aa5ed1a87',
  autobuy: '1',
  buytag: '',
  debug: '0',
  env: '0',
  goods_version: '65',
  hallID: '10054',
  inRealGame: '1',
  ingame: '137',
  new_h5: '1',
  offer_id: '1450019618',
  openid: 'ofr_W5TzWkjQDZkrf9ERGhglPq9k',
  pay_stage: '1',
  platform_id: '8',
  roomid: '216408',
  roomlevel: '0',
  roomtype: '67108864',
  tq_exp: '0',
  tq_level: '0',
  type: 'minigame',
  udid: 'minigame0f2d16b1b560ff9e2ce80fd2d319091a',
  vc_platform: 'rx_qipai_jiaxiang',
  virtual: '0',
  zone_id: '1'
};

/**
 * 生成支付请求完整参数
 * @param {Object} opts
 * @param {string} opts.userid      - 用户ID
 * @param {string} opts.token       - 会话token
 * @param {string} opts.goods       - 商品ID (如 goods_dressup_303)
 * @param {string} opts.money       - 价格 (单位:分, 如 3000)
 * @param {string} opts.body        - 商品描述 (如 入场动画)
 * @param {string} opts.subject     - 商品标题 (如 入场动画)
 * @param {string} opts.buy_num     - 购买数量 (默认 1)
 * @param {string} [opts.hashcode]  - 房间 hash（可选，默认自动生成）
 * @param {string} [opts.roomid]    - 房间 ID（可选）
 * @param {string} [opts.roomlevel] - 房间等级（可选）
 * @param {string} [opts.roomtype]  - 房间类型（可选）
 * @param {string} [opts.extra]     - ext 参数（默认 [object Object]）
 * @returns {Object} { params, queryString, websign, sign }
 */
function generatePayRequest(opts) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const signtstamp = Date.now().toString();

  const hashcode = opts.hashcode || (Math.floor(Math.random() * 9007199254740991) + 1000000000000000).toString();

  const params = {
    ...DEFAULTS,
    roomid: opts.roomid || DEFAULTS.roomid,
    roomlevel: opts.roomlevel || DEFAULTS.roomlevel,
    roomtype: opts.roomtype || DEFAULTS.roomtype,
    // 用户必填
    userid: opts.userid,
    token: opts.token,
    goods: opts.goods,
    money: opts.money,
    body: opts.body,
    subject: opts.subject || opts.body,
    buy_num: opts.buy_num || '1',
    ext: opts.extra || '[object Object]',
    // 时间戳
    ts,
    signtstamp,
    // biinfo
    biinfo: JSON.stringify({
      mark_scene_type: 8,
      source_scene: 'game',
      popup_type: 1,
      hashcode,
      game_id: 137,
      game_mode: 4,
      room_lv: 0,
      game_pnum: 4,
      event_cond_id: 'other'
    })
  };

  // 计算 websign
  // websign = MD5(signtstamp + path + MD5("1002_818_818_1002_" + userid).toLowerCase())
  const innerHash = hex_md5(`1002_818_818_1002_${opts.userid}`).toLowerCase();
  // path 来自 URL: /order/exchange/1002/818/{version}/{region}
  const websignPath = '/order/exchange/1002/818/1.8.300.167.869/420101';
  params.websign = hex_md5(signtstamp + websignPath + innerHash);

  // 计算 sign
  const keys = Object.keys(params).sort();
  let qs = '';
  for (const k of keys) {
    if (params[k] == null) continue;
    if (qs) qs += '&';
    qs += k + '=' + urlencode(String(params[k]));
  }

  const token = params.token.toLowerCase();
  const sign = hex_md5(qs + '&token=' + token);
  params.sign = sign;

  return {
    params,
    queryString: qs + '&sign=' + sign,
    sign,
    websign: params.websign
  };
}

// ============================================================
// 命令行用法
// ============================================================
if (require.main === module) {
  const result = generatePayRequest({
    userid: '864481965',
    token: '2d004484d655a14e9c24cf63ec2f4c43',
    goods: 'goods_dressup_303',
    money: '3000',
    body: '入场动画',
    subject: '入场动画',
    buy_num: '1'
  });

  console.log('=== 完整参数字符串 ===');
  console.log(result.queryString);
  console.log('\n=== 参数对象 ===');
  console.log(JSON.stringify(result.params, null, 2));
  console.log('\nsign:', result.sign);
  console.log('websign:', result.websign);
}

module.exports = { generatePayRequest };
