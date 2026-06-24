#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo " Speaker -- Update Check"
echo " ========================"
echo ""

# Get local commit
LOCAL=$(git rev-parse HEAD 2>/dev/null)
if [ -z "$LOCAL" ]; then
    echo " [!] Could not read local commit. Is git installed?"
    echo ""
    exit 1
fi

# Get remote commit SHA (uses existing git credentials, works with private repos)
echo " Checking GitHub..."
REMOTE=$(git ls-remote origin refs/heads/main 2>/dev/null | awk '{print $1}')

if [ -z "$REMOTE" ]; then
    echo " [!] Could not reach the remote repository."
    echo "     Check your internet connection."
    echo ""
    exit 1
fi

echo " Local  : $LOCAL"
echo " Remote : $REMOTE"
echo ""

if [ "$LOCAL" = "$REMOTE" ]; then
    echo " [OK] You are up to date."
else
    echo " [!!] Your copy is OUTDATED."
    echo ""
    echo " To update, run:"
    echo ""
    echo "   git pull"
fi

echo ""
