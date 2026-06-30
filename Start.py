#!/usr/bin/env python3
"""Start.py — thin wrapper, delegates to launcher.js"""
import os, sys, shutil

DIR = os.path.dirname(os.path.abspath(sys.argv[0]))

def find_node():
    for p in [
        os.path.join(DIR, 'bin', 'win',   'node.exe'),
        os.path.join(DIR, 'bin', 'linux', 'node'),
    ]:
        if os.path.exists(p): return p
    return shutil.which('node')

node = find_node()
if not node:
    print('ERROR: Node.js not found.')
    print('Run Download.bat (Windows) or ./Download.sh (Linux),')
    print('or install Node.js from https://nodejs.org/')
    sys.exit(1)

os.execv(node, [node, os.path.join(DIR, 'launcher.js')])
