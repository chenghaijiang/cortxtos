#!/bin/bash
# 把 ~/study/bigmodel 的学习资料纳入 CortxtOS 知识库，镜像原始目录结构到 notes/bigmodel/...
#   - Markdown：按相对路径原样拷进 vault
#   - PDF：poppler pdftotext 抽取为同名 .md（图片型/空抽取自动跳过）
#   - 统一为缺 frontmatter 的导入笔记补 schema 五字段（title/tags/created/source/type）
#   用法：scripts/import-bigmodel.sh [--dry-run] [--reindex]
#     --dry-run  只统计不写盘；  --reindex  导入后立即全量重建向量索引
set -uo pipefail
cd "$(dirname "$0")/.."
PACKAGE_ROOT="$PWD"

SRC_DEFAULT="/Users/chenghaijiang/study/bigmodel"
SRC="${BIGMODEL_SRC:-$SRC_DEFAULT}"
DRY=0; REINDEX=0
for a in "$@"; do
  [ "$a" = "--dry-run" ] && DRY=1
  [ "$a" = "--reindex" ] && REINDEX=1
done

# ---- vault 根（读配置，展开 ~）----
VAULT="$(node -e 'const os=require("os"),fs=require("fs"),path=require("path");const p=process.env.CORTXTOS_CONFIG||path.join(os.homedir(),".cortxtos/cortxtos.json");let v="~/cortxt-vault";try{v=JSON.parse(fs.readFileSync(p,"utf8")).vaultPath||v}catch(e){}if(v==="~")v=os.homedir();else if(v.startsWith("~/"))v=path.join(os.homedir(),v.slice(2));console.log(v)')"
DEST="$VAULT/notes/bigmodel"

[ -d "$SRC" ] || { echo "❌ 源目录不存在：$SRC"; exit 1; }

# ---- 过滤：排除噪音/测试夹具（venv、依赖、本项目自身、菜谱语料、数据夹具、隐藏目录）----
EXCL=(-not -path '*/.venv/*' -not -path '*/node_modules/*' -not -path '*/.git/*' \
      -not -path '*/.idea/*' -not -path '*/.ipynb_checkpoints/*' -not -path '*/dist-info/*' \
      -not -path '*/site-packages/*' -not -path '*/.agents/*' -not -path '*/cortxtOS/*' \
      -not -path '*/dishes/*' -not -path '*/data/*')

echo "📚 源目录：$SRC"
echo "🎯 入库到：notes/bigmodel/  （${DEST}）"
[ "$DRY" = 1 ] && echo "🔎 DRY-RUN：仅统计，不写盘"
echo

# ---- 1) Markdown：按相对路径拷贝 ----
md_n=0
while IFS= read -r -d '' f; do
  rel="${f#"$SRC"/}"
  out="$DEST/$rel"
  if [ "$DRY" = 0 ]; then mkdir -p "$(dirname "$out")"; cp "$f" "$out"; fi
  md_n=$((md_n + 1))
done < <(find "$SRC" -name '*.md' "${EXCL[@]}" -print0)
printf '📄 Markdown 拷贝：%d 篇\n' "$md_n"

# ---- 2) PDF：pdftotext 抽取为 .md，跳过图片型/空内容 ----
TMP="$(mktemp)"
pdf_ok=0; pdf_skip=0
while IFS= read -r -d '' f; do
  rel="${f#"$SRC"/}"; rel="${rel%.pdf}"
  out="$DEST/$rel.md"
  # 若同名 Markdown 已入库（上一步拷贝），PDF 抽取改用 .pdf.md 后缀，避免覆盖原文
  [ -f "$out" ] && out="$DEST/$rel.pdf.md"
  pdftotext -layout "$f" - >"$TMP" 2>/dev/null || : >"$TMP"
  # 抽取正文有效字符数（去空白）；过短判定为扫描件/图片型
  body_chars="$(tr -d '[:space:]' <"$TMP" | wc -c | tr -d ' ')"
  if [ "${body_chars:-0}" -lt 80 ]; then
    pdf_skip=$((pdf_skip + 1))
    echo "   ⏭️  跳过（近空/图片型，${body_chars} 字符）：$rel.pdf"
    continue
  fi
  if [ "$DRY" = 0 ]; then
    mkdir -p "$(dirname "$out")"
    { echo "# $(basename "$rel")"; echo; cat "$TMP"; } >"$out"
  fi
  pdf_ok=$((pdf_ok + 1))
done < <(find "$SRC" -name '*.pdf' "${EXCL[@]}" -print0)
printf '🖨️  PDF 抽取入库：%d 篇，跳过 %d 篇（图片型/无文本层）\n' "$pdf_ok" "$pdf_skip"
rm -f "$TMP"

# ---- 3) 为缺 frontmatter 的导入笔记补 schema 五字段 ----
if [ "$DRY" = 0 ] && [ -d "$DEST" ]; then
  fm_n=0
  while IFS= read -r -d '' md; do
    [ "$(head -1 "$md")" = "---" ] && continue          # 已有 frontmatter，跳过
    base="$(basename "$md" .md)"
    title="$(awk 'NR<=5 && /^# /{sub(/^# /,"");print;exit}' "$md")"
    [ -z "$title" ] && title="$base"
    created="$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%SZ' "$md")"
    leaf="$(basename "$(dirname "$md")")"
    leaf="$(echo "$leaf" | tr ' /' '__')"
    tmpf="$(mktemp)"
    { printf -- '---\ntitle: %s\ntags: [bigmodel, %s]\ncreated: %s\nsource: manual\ntype: note\n---\n\n' "$title" "$leaf" "$created"; cat "$md"; } >"$tmpf"
    mv "$tmpf" "$md"
    fm_n=$((fm_n + 1))
  done < <(find "$DEST" -name '*.md' -print0)
  printf '🏷️  补齐 frontmatter：%d 篇\n' "$fm_n"
fi

total="$(find "$DEST" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
echo
echo "✅ 导入完成：notes/bigmodel/ 下共 ${total:-0} 篇笔记"
[ "$DRY" = 1 ] && { echo "（dry-run 未写盘，去掉 --dry-run 正式执行）"; exit 0; }

# ---- 4) 脏标记 + 索引 ----
if [ "$REINDEX" = 1 ]; then
  echo "🔨 正在重建向量索引（本地 embedding，篇数多时较慢，请稍候）…"
  node bin/cortxtos.ts reindex
else
  echo "👉 下一步重建索引后新笔记才进入语义检索：  node bin/cortxtos.ts reindex"
  echo "   或重跑本脚本加 --reindex 一次到位。"
fi
