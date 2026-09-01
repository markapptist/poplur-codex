#!/usr/bin/env python3
"""Parse an xctrace cpu-profile export into real per-symbol sample/cycle counts.

xctrace compresses its XML: a frame appears with full attributes once and as
<frame ref="N"/> everywhere after. Counting name= occurrences therefore counts
distinct frame objects, not samples. This resolves the refs.
"""
import sys, collections, xml.etree.ElementTree as ET

def load(path):
    objs = {}          # id -> resolved value
    rows = []          # (thread_fmt, cycles, [frame names, leaf first])

    def resolve(el, kind):
        ref = el.get('ref')
        if ref is not None:
            return objs.get(ref)
        oid = el.get('id')
        if kind == 'frame':
            val = el.get('name') or el.get('addr') or '?'
            binel = el.find('binary')
            bin_name = None
            if binel is not None:
                bref = binel.get('ref')
                bin_name = objs.get(bref) if bref is not None else binel.get('name')
                if binel.get('id') is not None and binel.get('name'):
                    objs[binel.get('id')] = binel.get('name')
            val = (val, bin_name)
        elif kind in ('backtrace', 'tagged-backtrace'):
            inner = el.find('backtrace')
            if inner is not None:
                val = resolve(inner, 'backtrace')
            else:
                val = [resolve(f, 'frame') for f in el.findall('frame')]
        elif kind == 'weight':
            val = int(el.text) if (el.text or '').strip().isdigit() else 0
        else:
            val = el.get('fmt') or (el.text or '')
        if oid is not None:
            objs[oid] = val
        return val

    for _, row in ET.iterparse(path, events=('end',)):
        if row.tag != 'row':
            continue
        thread = cycles = stack = proc = None
        for child in row:
            if child.tag == 'thread':
                thread = resolve(child, 'thread')
            elif child.tag == 'process':
                proc = resolve(child, 'process')
            elif child.tag == 'cycle-weight':
                cycles = resolve(child, 'weight')
            elif child.tag == 'tagged-backtrace':
                stack = resolve(child, 'tagged-backtrace')
        rows.append((thread or '?', cycles or 0, stack or [], proc or '?'))
        row.clear()
    return rows

def sym(f):
    if f is None:
        return ('?', None)
    return f

def report(path, label):
    rows = load(path)
    total_samples = len(rows)
    total_cycles = sum(r[1] for r in rows)
    self_s = collections.Counter()   # leaf frame -> samples
    incl_s = collections.Counter()   # any frame in stack -> samples (once per stack)
    bin_s = collections.Counter()
    thread_s = collections.Counter()
    proc_s = collections.Counter()
    proc_c = collections.Counter()
    for thread, cyc, stack, proc in rows:
        thread_s[thread.split(' (0x')[0]] += 1
        proc_s[proc] += 1
        proc_c[proc] += cyc
        if not stack:
            continue
        leaf = sym(stack[0])
        self_s[leaf[0]] += 1
        bin_s[leaf[1] or '?'] += 1
        seen = set()
        for f in stack:
            n = sym(f)[0]
            if n not in seen:
                seen.add(n)
                incl_s[n] += 1
    return dict(label=label, path=path, total_samples=total_samples,
                total_cycles=total_cycles, self_s=self_s, incl_s=incl_s,
                bin_s=bin_s, thread_s=thread_s, proc_s=proc_s, proc_c=proc_c)

def show(r, top=18):
    print(f"\n{'='*72}\n{r['label']}  ({r['total_samples']} samples, {r['total_cycles']/1e9:.2f}G cycles)\n{'='*72}")
    print("-- threads --")
    for k, n in r['thread_s'].most_common(6):
        print(f"  {n:6d}  {k[:60]}")
    print("-- binaries by SELF samples --")
    for k, n in r['bin_s'].most_common(10):
        print(f"  {n:6d} ({100*n/max(r['total_samples'],1):5.1f}%)  {k[:56]}")
    print("-- hottest symbols by SELF samples --")
    for k, n in r['self_s'].most_common(top):
        print(f"  {n:6d}  {k[:70]}")

if __name__ == '__main__':
    rs = [report(p, l) for p, l in zip(sys.argv[1::2], sys.argv[2::2])]
    for r in rs:
        show(r)
