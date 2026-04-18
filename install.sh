#!/usr/bin/env bash

set -euo pipefail

PI_DIR="$HOME/.pi"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check if ~/.pi/agent exists
if [ ! -d "$PI_DIR" ]; then
    echo "Error: $PI_DIR does not exist. Is pi installed?"
    exit 1
fi

dest="$PI_DIR/agent"
src="$ROOT_DIR/agent"
if [ -L "$dest" ]; then
    existing="$(readlink "$dest")"
    if [ "$existing" = "$src" ]; then
        echo "already linked"
        exit 0
    fi
    echo "updating symlink (was $existing)"
    rm "$dest"
elif [ -e "$dest" ]; then
    echo "Error: $dest already exists and is not a symlink. Remove it manually."
    exit 1
fi

ln -s "$src" "$dest"
echo "linked $src -> $dest"
