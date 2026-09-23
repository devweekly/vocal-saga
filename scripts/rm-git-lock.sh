#!/bin/sh
#
# 清除 git 的陈旧锁文件（.git/index.lock 等）。
#
# 背景：本仓库会被 IDE 后台 git 集成 / 多个 AI 会话并发操作，git 进程被中断时
# 不会走 cleanup（SIGKILL 不给机会），留下的 0 字节锁会让后续所有 git 命令报
# "Unable to create '.git/index.lock': File exists"。
#
# 用法：
#   sh scripts/rm-git-lock.sh          # 安全检查后删除
#   sh scripts/rm-git-lock.sh --force  # 跳过检查，直接删
#   sh scripts/rm-git-lock.sh --list   # 只列出，不删
#
# 安全检查：若仍有 git 进程在跑（pgrep -x git），或锁文件被某进程持有（lsof），
# 说明锁是活的，默认拒绝删除 —— 强删会让正在写的进程产出损坏的 index。
#
# 注意：排查"有没有 git 进程"必须用精确匹配。宽泛的 `ps aux | grep git` 会命中
# VS Code 的 Code Helper、WorkBuddy 的 sandbox-cli 等（路径里含 "git"），全是噪声。

set -eu

FORCE=0
LIST_ONLY=0

for arg in "$@"; do
  case "$arg" in
    -f | --force) FORCE=1 ;;
    -l | --list) LIST_ONLY=1 ;;
    -h | --help)
      # 打印本文件顶部的注释块
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数: $arg（-h 查看用法）" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# 定位 .git 目录
# ---------------------------------------------------------------------------
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || true)
if [ -z "$GIT_DIR" ]; then
  echo "✗ 当前目录不在 git 仓库内" >&2
  exit 1
fi
# rev-parse 在仓库内可能返回相对路径（.git），转成绝对路径
case "$GIT_DIR" in
  /*) ;;
  *) GIT_DIR="$(pwd)/$GIT_DIR" ;;
esac

# ---------------------------------------------------------------------------
# 收集锁文件
#
# 用 for 而不是 `find | while`：管道会把循环体放进子 shell，
# 循环里做的判断和计数传不出来（安全检查会静默失效）。
# 锁文件名固定且不含空格，按行切分是安全的。
# ---------------------------------------------------------------------------
LOCKS=$(find "$GIT_DIR" -maxdepth 3 -name '*.lock' -type f 2>/dev/null || true)

if [ -z "$LOCKS" ]; then
  echo "✓ 没有锁文件，无需清理"
  exit 0
fi

# 文件 mtime（秒）。macOS 与 GNU/Linux 的 stat 参数不同，依次尝试。
file_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

now=$(date +%s)

echo "发现锁文件："
for lock in $LOCKS; do
  mtime=$(file_mtime "$lock")
  if [ "$mtime" = "0" ]; then
    age="未知"
  else
    diff=$((now - mtime))
    if [ "$diff" -lt 60 ]; then
      age="${diff} 秒前"
    elif [ "$diff" -lt 3600 ]; then
      age="$((diff / 60)) 分钟前"
    else
      age="$((diff / 3600)) 小时前"
    fi
  fi
  rel=${lock#"$GIT_DIR"/}
  if [ -s "$lock" ]; then
    size="非空 $(wc -c < "$lock" | tr -d ' ') 字节"
  else
    size="0 字节"
  fi
  echo "  $rel  ($size, 创建于 $age)"
done

if [ "$LIST_ONLY" = "1" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# 安全检查：锁是否还活着
# ---------------------------------------------------------------------------
if [ "$FORCE" != "1" ]; then
  alive=0

  if pgrep -x git >/dev/null 2>&1; then
    echo "" >&2
    echo "✗ 检测到 git 进程正在运行，锁可能是活的：" >&2
    pgrep -lx git >&2
    alive=1
  fi

  for lock in $LOCKS; do
    # lsof 在部分环境不存在，失败时静默跳过这项检查
    if command -v lsof >/dev/null 2>&1 && lsof "$lock" >/dev/null 2>&1; then
      echo "" >&2
      echo "✗ $lock 正被以下进程持有：" >&2
      lsof "$lock" >&2
      alive=1
    fi
  done

  if [ "$alive" = "1" ]; then
    echo "" >&2
    echo "先等几秒重试。确认进程确实已退出后，再加 --force 强制清除：" >&2
    echo "  sh scripts/rm-git-lock.sh --force" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 删除
# ---------------------------------------------------------------------------
count=0
for lock in $LOCKS; do
  if rm -f "$lock"; then
    echo "  已删除 ${lock#"$GIT_DIR"/}"
    count=$((count + 1))
  fi
done

echo ""
echo "✓ 已清除 $count 个锁文件，git 命令现在可用"
