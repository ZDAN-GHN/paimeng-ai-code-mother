# 字体

原型自托管四个子集，运行时不请求任何字体服务。

| 文件 | 字体 | 用途 | 许可 |
| --- | --- | --- | --- |
| `NotoSerifSC-subset.woff2` | [Noto Serif SC](https://fonts.google.com/noto/specimen/Noto+Serif+SC) | 标题、衬线正文、样张里的书名 | SIL OFL 1.1，见 `NotoSerifSC-OFL.txt` |
| `NotoSansSC-subset.woff2` | [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC) | 界面正文、标签 | SIL OFL 1.1，见 `NotoSansSC-OFL.txt` |
| `Archivo-subset.woff2` | [Archivo](https://fonts.google.com/specimen/Archivo) | 拉丁标签、卷号、英文字样 | SIL OFL 1.1，见 `Archivo-OFL.txt` |
| `SplineSansMono-subset.woff2` | [Spline Sans Mono](https://fonts.google.com/specimen/Spline+Sans+Mono) | 帧号、时间、代码 | SIL OFL 1.1，见 `SplineSansMono-OFL.txt` |

这些 woff2 是用 `pyftsubset` 从官方可变字体切出的**子集**，只包含原型用到的 618 个字符，因此文件很小；完整字体的授权仍以 OFL 为准。中文没有回退到网络字体；如果某个新加的字不在子集里，会落到系统中文衬线/无衬线。

重新生成子集：

```bash
python3 - <<'PY'
from pathlib import Path
text=''.join(Path(f).read_text() for f in ['index.html','style.css','app.js'])
Path('/tmp/chars.txt').write_text(''.join(sorted(set(text))))
PY
pyftsubset NotoSerifSC-var.ttf --text-file=/tmp/chars.txt --flavor=woff2 --output-file=fonts/NotoSerifSC-subset.woff2
```
