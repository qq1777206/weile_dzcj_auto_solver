#!/usr/bin/env python3
import argparse
import itertools
from dataclasses import dataclass
from functools import lru_cache
from typing import Dict, List, Optional, Tuple

RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2", "X", "D"]
RANK_TO_IDX = {r: i for i, r in enumerate(RANKS)}
IDX_TO_OUT = {
    **{i: r for i, r in enumerate(RANKS[:-2])},
    13: "小王",
    14: "大王",
}

PASS = "PASS"


@dataclass(frozen=True)
class Play:
    kind: str
    main: int
    length: int
    delta: Tuple[int, ...]
    text: str

    def trick_key(self) -> Tuple[str, int, int]:
        return (self.kind, self.main, self.length)


NORMALIZE_MAP = {
    "小王": "X",
    "大王": "D",
    "joker": "",
    "JOKER": "",
}


def normalize_hand_text(raw: str) -> str:
    s = raw.strip()
    for k, v in NORMALIZE_MAP.items():
        s = s.replace(k, v)
    s = s.replace("，", "").replace(",", "").replace(" ", "")
    s = s.upper()
    return s


def parse_hand(raw: str) -> Tuple[int, ...]:
    s = normalize_hand_text(raw)
    counts = [0] * len(RANKS)
    i = 0
    while i < len(s):
        two = s[i : i + 2]
        if two == "10":
            counts[RANK_TO_IDX["10"]] += 1
            i += 2
            continue
        if two == "BJ":
            counts[RANK_TO_IDX["D"]] += 1
            i += 2
            continue
        if two == "RJ":
            counts[RANK_TO_IDX["X"]] += 1
            i += 2
            continue
        ch = s[i]
        if ch in RANK_TO_IDX:
            counts[RANK_TO_IDX[ch]] += 1
            i += 1
            continue
        raise ValueError(f"无法识别的牌字符: {ch!r}，原输入: {raw!r}")
    return tuple(counts)


def counts_to_text(counts: Tuple[int, ...]) -> str:
    out: List[str] = []
    for i in range(len(RANKS) - 1, -1, -1):
        out.extend([IDX_TO_OUT[i]] * counts[i])
    return "".join(out) if out else "(空)"


def delta_from_indices(indices: List[int]) -> Tuple[int, ...]:
    d = [0] * len(RANKS)
    for idx in indices:
        d[idx] += 1
    return tuple(d)


def delta_to_text(delta: Tuple[int, ...]) -> str:
    cards: List[str] = []
    for i in range(len(RANKS) - 1, -1, -1):
        cards.extend([IDX_TO_OUT[i]] * delta[i])
    return "".join(cards)


def apply_delta(counts: Tuple[int, ...], delta: Tuple[int, ...]) -> Tuple[int, ...]:
    out = [c - d for c, d in zip(counts, delta)]
    return tuple(out)


def can_beat(play: Play, trick: Play) -> bool:
    if play.kind == "rocket":
        return True
    if trick.kind == "rocket":
        return False

    if play.kind == "bomb":
        if trick.kind != "bomb":
            return True
        return play.main > trick.main

    if trick.kind == "bomb":
        return False

    if play.kind != trick.kind:
        return False

    if play.length != trick.length:
        return False

    return play.main > trick.main


class Solver:
    def __init__(self) -> None:
        self.state_cache: Dict[Tuple[Tuple[int, ...], Tuple[int, ...], int, Optional[Tuple[str, int, int]]], bool] = {}

    @lru_cache(maxsize=200000)
    def generate_all_plays(self, hand: Tuple[int, ...]) -> Tuple[Play, ...]:
        c = hand
        plays: List[Play] = []

        def add_play(kind: str, main: int, length: int, indices: List[int]) -> None:
            delta = delta_from_indices(indices)
            text = delta_to_text(delta)
            plays.append(Play(kind=kind, main=main, length=length, delta=delta, text=text))

        # 单张 / 对子 / 三张 / 炸弹
        for i, cnt in enumerate(c):
            if cnt >= 1:
                add_play("single", i, 1, [i])
            if cnt >= 2:
                add_play("pair", i, 1, [i, i])
            if cnt >= 3:
                add_play("triple", i, 1, [i, i, i])
            if cnt == 4:
                add_play("bomb", i, 1, [i, i, i, i])

        # 王炸
        if c[13] >= 1 and c[14] >= 1:
            add_play("rocket", 14, 1, [13, 14])

        # 顺子（5张起，不含2和王）
        for start in range(0, 12):
            if c[start] < 1:
                continue
            end = start
            while end < 12 and c[end] >= 1:
                end += 1
            run_len = end - start
            if run_len >= 5:
                for length in range(5, run_len + 1):
                    for s in range(start, end - length + 1):
                        seq = list(range(s, s + length))
                        add_play("straight", s + length - 1, length, seq)
            start = end

        # 连对（3对起）
        for start in range(0, 12):
            if c[start] < 2:
                continue
            end = start
            while end < 12 and c[end] >= 2:
                end += 1
            run_len = end - start
            if run_len >= 3:
                for length in range(3, run_len + 1):
                    for s in range(start, end - length + 1):
                        seq: List[int] = []
                        for r in range(s, s + length):
                            seq.extend([r, r])
                        add_play("pair_straight", s + length - 1, length, seq)
            start = end

        # 飞机不带（两连三起）
        for start in range(0, 12):
            if c[start] < 3:
                continue
            end = start
            while end < 12 and c[end] >= 3:
                end += 1
            run_len = end - start
            if run_len >= 2:
                for length in range(2, run_len + 1):
                    for s in range(start, end - length + 1):
                        seq: List[int] = []
                        for r in range(s, s + length):
                            seq.extend([r, r, r])
                        add_play("triple_straight", s + length - 1, length, seq)
            start = end

        # 飞机带单 / 飞机带双（两连三起，带等量单牌或对子）
        for start in range(0, 12):
            if c[start] < 3:
                continue
            end = start
            while end < 12 and c[end] >= 3:
                end += 1
            run_len = end - start
            if run_len >= 2:
                for length in range(2, run_len + 1):
                    for s in range(start, end - length + 1):
                        tri_indices: List[int] = []
                        for r in range(s, s + length):
                            tri_indices.extend([r, r, r])
                        # 剩余可用的牌（扣除三连）
                        remain = list(c)
                        for r in range(s, s + length):
                            remain[r] -= 3
                        # 飞机带单: 选 length 个单牌
                        avail_singles = [i for i, cnt in enumerate(remain) if cnt >= 1]
                        if len(avail_singles) >= length:
                            for kickers in itertools.combinations(avail_singles, length):
                                seq = list(tri_indices)
                                for k in kickers:
                                    seq.append(k)
                                add_play("plane_single", s + length - 1, length, seq)
                        # 飞机带双: 选 length 个对子
                        avail_pairs = [i for i, cnt in enumerate(remain) if cnt >= 2]
                        if len(avail_pairs) >= length:
                            for kickers in itertools.combinations(avail_pairs, length):
                                seq = list(tri_indices)
                                for k in kickers:
                                    seq.extend([k, k])
                                add_play("plane_pair", s + length - 1, length, seq)
            start = end

        # 三带一 / 三带二
        triples = [i for i, cnt in enumerate(c) if cnt >= 3]
        singles = [i for i, cnt in enumerate(c) if cnt >= 1]
        pairs = [i for i, cnt in enumerate(c) if cnt >= 2]

        for t in triples:
            for s in singles:
                if s == t:
                    continue
                add_play("triple_single", t, 1, [t, t, t, s])
            for p in pairs:
                if p == t:
                    continue
                add_play("triple_pair", t, 1, [t, t, t, p, p])

        # 四带二单 / 四带二双
        fours = [i for i, cnt in enumerate(c) if cnt >= 4]
        single_kickers = [i for i, cnt in enumerate(c) if cnt >= 1]
        pair_kickers = [i for i, cnt in enumerate(c) if cnt >= 2]

        for f in fours:
            # 四带二单：两张不同的单牌
            for j, s1 in enumerate(single_kickers):
                if s1 == f:
                    continue
                for s2 in single_kickers[j + 1:]:
                    if s2 == f:
                        continue
                    add_play("four_two_single", f, 1, [f, f, f, f, s1, s2])
            # 四带二双：两个不同的对子
            for j, p1 in enumerate(pair_kickers):
                if p1 == f:
                    continue
                for p2 in pair_kickers[j + 1:]:
                    if p2 == f:
                        continue
                    add_play("four_two_pair", f, 1, [f, f, f, f, p1, p1, p2, p2])

        # 去重（同 kind/main/length 且 delta 相同）
        uniq: Dict[Tuple[str, int, int, Tuple[int, ...]], Play] = {}
        for p in plays:
            uniq[(p.kind, p.main, p.length, p.delta)] = p

        ordered = sorted(
            uniq.values(),
            key=lambda x: (x.kind, x.length, x.main, x.text),
        )
        return tuple(ordered)

    def legal_moves(self, hand: Tuple[int, ...], trick: Optional[Play]) -> List[Play | str]:
        all_plays = self.generate_all_plays(hand)
        if trick is None:
            return list(all_plays)

        beats = [p for p in all_plays if can_beat(p, trick)]
        beats.append(PASS)
        return beats

    def solve(
        self,
        my_hand: Tuple[int, ...],
        opp_hand: Tuple[int, ...],
        turn: int,
        trick: Optional[Play],
    ) -> bool:
        if sum(my_hand) == 0:
            return True
        if sum(opp_hand) == 0:
            return False

        key = (my_hand, opp_hand, turn, trick.trick_key() if trick else None)
        if key in self.state_cache:
            return self.state_cache[key]

        if turn == 0:
            # 我方回合：存在一手能赢即可
            for mv in self.legal_moves(my_hand, trick):
                if mv == PASS:
                    if self.solve(my_hand, opp_hand, 1, None):
                        self.state_cache[key] = True
                        return True
                    continue

                next_my = apply_delta(my_hand, mv.delta)
                if sum(next_my) == 0:
                    self.state_cache[key] = True
                    return True

                if self.solve(next_my, opp_hand, 1, mv):
                    self.state_cache[key] = True
                    return True

            self.state_cache[key] = False
            return False

        # 对手回合：只要存在一手让我方输，则我方无法强制赢
        for mv in self.legal_moves(opp_hand, trick):
            if mv == PASS:
                if not self.solve(my_hand, opp_hand, 0, None):
                    self.state_cache[key] = False
                    return False
                continue

            next_opp = apply_delta(opp_hand, mv.delta)
            if sum(next_opp) == 0:
                self.state_cache[key] = False
                return False

            if not self.solve(my_hand, next_opp, 0, mv):
                self.state_cache[key] = False
                return False

        self.state_cache[key] = True
        return True

    @staticmethod
    def _kind_priority(kind: str) -> int:
        # 越低越好：优先出单牌保留炸弹/火箭等大牌
        order = {
            'single': 1, 'pair': 2, 'triple': 3,
            'straight': 4, 'pair_straight': 4, 'triple_straight': 4,
            'triple_single': 5, 'triple_pair': 5,
            'plane_single': 4, 'plane_pair': 4,
            'four_two_single': 6, 'four_two_pair': 6,
            'bomb': 7, 'rocket': 8,
        }
        return order.get(kind, 5)

    def best_move(self, my_hand: Tuple[int, ...], opp_hand: Tuple[int, ...], trick: Optional[Play]) -> Play | str:
        legal = self.legal_moves(my_hand, trick)
        winning: List[Play | str] = []
        losing: List[Play | str] = []

        for mv in legal:
            if mv == PASS:
                ok = self.solve(my_hand, opp_hand, 1, None)
            else:
                next_my = apply_delta(my_hand, mv.delta)
                if sum(next_my) == 0:
                    ok = True
                else:
                    ok = self.solve(next_my, opp_hand, 1, mv)
            (winning if ok else losing).append(mv)

        if winning:
            return winning[0]

        # 无强制赢则选择"最好的输法":
        # 优先用单牌/对子管牌（消耗小，给对手犯错机会）
        # PASS 仅当管不起或需要炸弹时才选（保留炸弹/火箭用于防守）
        # 优先级: 单牌>对子>三张>顺子类>不出>四带>炸弹>火箭
        # 同类型中: 牌数少优先, main大优先(出大牌给对手压力)
        def losing_key(mv: Play | str) -> Tuple[int, int, int, int]:
            if mv == PASS:
                # PASS 排在普通出牌之后，炸弹/火箭之前
                return (5, 0, 0, 0)
            kind_p = Solver._kind_priority(mv.kind)
            count = sum(mv.delta)
            # main 取负值：同类型中优先出大牌，迫使对手用更大牌管
            return (kind_p, count, -mv.main, len(mv.text))

        losing.sort(key=losing_key)
        return losing[0]

    def opp_best_defense(self, my_hand: Tuple[int, ...], opp_hand: Tuple[int, ...], trick: Optional[Play]) -> Play | str:
        legal = self.legal_moves(opp_hand, trick)
        # 对手优先选择让“我方无法强制赢”的走法
        for mv in legal:
            if mv == PASS:
                ok = self.solve(my_hand, opp_hand, 0, None)
            else:
                next_opp = apply_delta(opp_hand, mv.delta)
                if sum(next_opp) == 0:
                    ok = False
                else:
                    ok = self.solve(my_hand, next_opp, 0, mv)
            if not ok:
                return mv
        return legal[0]


def move_to_text(mv: Play | str) -> str:
    if mv == PASS:
        return "不出"
    return mv.text

def move_to_machine_text(mv: Play | str) -> str:
    """返回纯 ASCII 的牌面文本（前端解析用，避免编码问题）"""
    if mv == PASS:
        return "PASS"
    # 把中文大王/小王替换为 D/X
    return mv.text.replace("大王", "D").replace("小王", "X")


def analyze_first_moves(solver: Solver, my_hand: Tuple[int, ...], opp_hand: Tuple[int, ...]) -> List[Tuple[Play, bool]]:
    out: List[Tuple[Play, bool]] = []
    for mv in solver.legal_moves(my_hand, None):
        if mv == PASS:
            continue
        next_my = apply_delta(my_hand, mv.delta)
        if sum(next_my) == 0:
            ok = True
        else:
            ok = solver.solve(next_my, opp_hand, 1, mv)
        out.append((mv, ok))
    return out


def principal_variation(
    solver: Solver,
    my_hand: Tuple[int, ...],
    opp_hand: Tuple[int, ...],
    first_turn: int,
    max_steps: int = 40,
) -> List[str]:
    lines: List[str] = []
    turn = first_turn
    trick: Optional[Play] = None
    my = my_hand
    opp = opp_hand

    for step in range(max_steps):
        if sum(my) == 0:
            lines.append("我方出完，胜利")
            break
        if sum(opp) == 0:
            lines.append("对方出完，我方失败")
            break

        if turn == 0:
            mv = solver.best_move(my, opp, trick)
            lines.append(f"我方: {move_to_text(mv)}")
            if mv == PASS:
                trick = None
            else:
                my = apply_delta(my, mv.delta)
                trick = mv
            turn = 1
        else:
            mv = solver.opp_best_defense(my, opp, trick)
            lines.append(f"对方: {move_to_text(mv)}")
            if mv == PASS:
                trick = None
            else:
                opp = apply_delta(opp, mv.delta)
                trick = mv
            turn = 0

    return lines


def main() -> None:
    parser = argparse.ArgumentParser(description="双人明牌最优出牌求解器（简化斗地主规则）")
    parser.add_argument("--mine", help="我方手牌，例如: 大王99553")
    parser.add_argument("--opponent", help="对方手牌，例如: aa7755")
    parser.add_argument(
        "--first",
        choices=["me", "opponent"],
        default="me",
        help="先手方，默认 me",
    )
    parser.add_argument("--trick", help="当前桌面的牌型（管牌时需要），例如: 3334")
    args = parser.parse_args()

    mine_raw = args.mine
    opp_raw = args.opponent
    first = args.first
    trick_raw = args.trick

    if not mine_raw:
        mine_raw = input("输入我方手牌: ").strip()
    if not opp_raw:
        opp_raw = input("输入对方手牌: ").strip()

    try:
        my_hand = parse_hand(mine_raw)
        opp_hand = parse_hand(opp_raw)
    except ValueError as e:
        print(f"输入错误: {e}")
        return

    solver = Solver()

    # 解析 trick（如果有）
    trick = None
    if trick_raw:
        trick_counts = parse_hand(trick_raw)
        # 在 generate_all_plays 中找到完全匹配的 Play
        candidates = [p for p in solver.generate_all_plays(trick_counts) if p.delta == trick_counts]
        if candidates:
            trick = candidates[0]
        else:
            # fallback: 创建通用 Play
            trick = Play("unknown", 0, 1, trick_counts, delta_to_text(trick_counts))

    first_turn = 0 if first == "me" else 1

    # 当有 trick 时，不管 --first 是什么，都认为是"我方需要管牌"
    # 即：对方出了牌，轮到我了
    if trick is not None:
        can_force_win = solver.solve(my_hand, opp_hand, 0, trick)
    else:
        can_force_win = solver.solve(my_hand, opp_hand, first_turn, None)

    # 建议出手
    if trick is not None:
        recommended = solver.best_move(my_hand, opp_hand, trick)
    elif first_turn == 0:
        recommended = solver.best_move(my_hand, opp_hand, None)
    else:
        recommended = solver.best_move(my_hand, opp_hand, None)

    # 机器可读结果行（前端解析用，纯 ASCII）
    rec_text = move_to_machine_text(recommended)
    print(f"__RESULT__ can_win={'true' if can_force_win else 'false'} suggestion={rec_text}")

    print("=" * 56)
    print(f"我方手牌: {counts_to_text(my_hand)}")
    print(f"对方手牌: {counts_to_text(opp_hand)}")
    if trick:
        print(f"管牌: {move_to_text(trick)}")
    print(f"先手方: {'我方' if first_turn == 0 else '对方'}")
    print(f"结论: {'我方可强制获胜' if can_force_win else '我方无法强制获胜'}")

    print(f"\n建议出牌: {move_to_text(recommended)}")

    if first_turn == 0:
        detail = analyze_first_moves(solver, my_hand, opp_hand)
        detail.sort(key=lambda x: (not x[1], x[0].kind, x[0].length, x[0].main, x[0].text))

        print("\n首手评估:")
        for mv, ok in detail:
            print(f"- {mv.text:<12} -> {'可赢' if ok else '不可强制赢'}")

    line = principal_variation(solver, my_hand, opp_hand, first_turn)
    print("\n一条最优对抗线路:")
    for i, step in enumerate(line, 1):
        print(f"{i:02d}. {step}")


if __name__ == "__main__":
    main()
