"""Stage only the hunks of one file whose changed lines match a regex.

Usage: stage-hunks.py <path> <regex> [--invert]
Builds a patch from `git diff -- path` keeping matching hunks and applies it
to the index, so a file two concerns share can be committed one at a time.
"""
import re, subprocess, sys
path, pattern = sys.argv[1], sys.argv[2]
invert = '--invert' in sys.argv
diff = subprocess.run(['git', 'diff', '-U3', '--', path], capture_output=True, text=True, check=True).stdout
lines = diff.splitlines(keepends=True)
header, hunks, cur = [], [], None
for line in lines:
    if line.startswith('@@'):
        cur = [line]; hunks.append(cur)
    elif cur is None:
        header.append(line)
    else:
        cur.append(line)
rx = re.compile(pattern)
keep = []
for h in hunks:
    changed = ''.join(l for l in h[1:] if l[0] in '+-')
    hit = bool(rx.search(changed))
    if hit != invert: keep.append(h)
if not keep:
    print('no matching hunks'); sys.exit(1)
patch = ''.join(header) + ''.join(''.join(h) for h in keep)
res = subprocess.run(['git', 'apply', '--cached', '--recount', '-'], input=patch, text=True, capture_output=True)
print(f'{path}: staged {len(keep)}/{len(hunks)} hunks', '(invert)' if invert else '')
if res.returncode: print(res.stderr); sys.exit(res.returncode)
