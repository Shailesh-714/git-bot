#!/usr/bin/env bash
set -euo pipefail

APP="git-bot"
REPO="Shailesh-714/git-bot"
INSTALL_DIR="$HOME/.$APP"

usage() {
  cat <<EOF
$APP Installer (via GitHub Releases)

Usage: install.sh [options]

Options:
  -h, --help              Display this help message
  -v, --version <version> Install a specific version (e.g., 0.1.1)
      --no-modify-path    Do not modify shell config files

Examples:
  curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash
  curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash -s -- --version 0.1.1
EOF
}

requested_version="${VERSION:-}"
no_modify_path=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    -v | --version)
      if [[ -n "${2:-}" ]]; then
        requested_version="$2"
        shift 2
      else
        echo "Error: --version requires a version argument" >&2
        exit 1
      fi
      ;;
    --no-modify-path)
      no_modify_path=true
      shift
      ;;
    *)
      echo "Warning: Unknown option '$1'" >&2
      shift
      ;;
  esac
done

# --- Helpers -----------------------------------------------------------------

download() {
  local url="$1"
  local output="${2:-}"
  local curl_flags=(-fsSL --retry 3 --retry-delay 2 --retry-all-errors)
  curl_flags+=(-H "User-Agent: ${APP}-installer")

  if [[ -n "$output" ]]; then
    curl "${curl_flags[@]}" "$url" -o "$output"
  else
    curl "${curl_flags[@]}" "$url"
  fi
}

# --- Detect OS / Arch --------------------------------------------------------

raw_os=$(uname -s)
os=$(echo "$raw_os" | tr '[:upper:]' '[:lower:]')
case "$raw_os" in
  Darwin*) os="darwin" ;;
  Linux*) os="linux" ;;
  MINGW* | MSYS* | CYGWIN*) os="windows" ;;
esac

arch=$(uname -m)
case "$arch" in
  aarch64 | arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
esac

if [[ "$os" == "darwin" && "$arch" == "x64" ]]; then
  rosetta_flag=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
  if [[ "$rosetta_flag" == "1" ]]; then
    arch="arm64"
  fi
fi

case "$os" in
  linux | darwin) ext="tar.gz" ;;
  windows) ext="zip" ;;
  *)
    echo "Error: Unsupported OS: $raw_os" >&2
    exit 1
    ;;
esac

case "$arch" in
  x64 | arm64) ;;
  *)
    echo "Error: Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

filename="$APP-$os-$arch.$ext"

# --- Check prerequisites -----------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required but not installed." >&2
  echo "Please install Node.js >= 20 and try again: https://nodejs.org/" >&2
  echo "Alternatively, install via npm:  npm install -g @shailesh-714/git-bot" >&2
  exit 1
fi

node_major=$(node -p 'process.version.match(/^v(\d+)/)[1]')
if [[ "$node_major" -lt 20 ]]; then
  echo "Error: Node.js >= 20 is required (found $(node --version))." >&2
  exit 1
fi

if [[ "$os" != "windows" && ! -x "$(command -v tar)" ]]; then
  echo "Error: 'tar' is required but not installed." >&2
  exit 1
fi

# --- Resolve URL (no GitHub API calls — avoids rate-limit 403s) --------------

# When no version is specified, use the /releases/latest/download/ URL.
# GitHub's web server resolves this to the latest release tag automatically,
# without consuming an unauthenticated API request (limit: 60/hour/IP).
if [[ -z "$requested_version" ]]; then
  url="https://github.com/$REPO/releases/latest/download/$filename"
  version_label="latest"
else
  requested_version="${requested_version#v}"
  version_label="v${requested_version}"
  url="https://github.com/$REPO/releases/download/v${requested_version}/$filename"
fi

# --- Download and install ----------------------------------------------------

echo "Installing $APP ($version_label, $os/$arch)..."

tmp_dir="${TMPDIR:-/tmp}/${APP}_install_$$"
mkdir -p "$tmp_dir"
trap 'rm -rf "$tmp_dir"' EXIT

if ! download "$url" "$tmp_dir/$filename"; then
  echo "" >&2
  echo "Error: Failed to download $url" >&2
  echo "" >&2
  echo "This may be a temporary network issue. Try again in a minute," >&2
  echo "or install via npm instead:  npm install -g @shailesh-714/git-bot" >&2
  exit 1
fi

if [[ "$ext" == "tar.gz" ]]; then
  tar -xzf "$tmp_dir/$filename" -C "$tmp_dir"
else
  unzip -q "$tmp_dir/$filename" -d "$tmp_dir"
fi

rm -rf "$INSTALL_DIR"
mv "$tmp_dir/$APP" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/bin/$APP"

# Read the actual version from the extracted package.json (for display only)
specific_version="unknown"
if [[ -f "$INSTALL_DIR/package.json" ]]; then
  specific_version=$(node -p 'require(require("path").join(process.argv[1], "package.json")).version' "$INSTALL_DIR" 2>/dev/null || echo "unknown")
fi

# --- Verify install ----------------------------------------------------------

if ! "$INSTALL_DIR/bin/$APP" --version >/dev/null 2>&1; then
  echo "Error: Installation verification failed." >&2
  echo "The binary was installed but does not run correctly." >&2
  exit 1
fi

# --- Update PATH -------------------------------------------------------------

add_to_path() {
  local config_file="$1"
  local command="$2"

  if grep -Fxq "$command" "$config_file" 2>/dev/null; then
    echo "PATH entry already exists in $(basename "$config_file"), skipping."
    return
  fi

  if [[ -w "$config_file" ]]; then
    echo -e "\n# $APP" >> "$config_file"
    echo "$command" >> "$config_file"
    echo "Added $INSTALL_DIR/bin to PATH in $(basename "$config_file")"
  else
    echo "Warning: Could not write to $config_file. Add this manually:"
    echo "  $command"
  fi
}

if [[ "$no_modify_path" != "true" ]]; then
  current_shell="${SHELL:-sh}"
  current_shell=$(basename "$current_shell" 2>/dev/null || echo "sh")
  config_file=""

  case "$current_shell" in
    zsh) config_file="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [[ -f "$HOME/.bashrc" ]]; then
        config_file="$HOME/.bashrc"
      elif [[ -f "$HOME/.bash_profile" ]]; then
        config_file="$HOME/.bash_profile"
      else
        config_file="$HOME/.profile"
      fi
      ;;
    fish) config_file="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
    *) config_file="$HOME/.profile" ;;
  esac

  if [[ -n "$config_file" && -f "$config_file" ]]; then
    if [[ ":$PATH:" != *":$INSTALL_DIR/bin:"* ]]; then
      if [[ "$current_shell" == "fish" ]]; then
        add_to_path "$config_file" "fish_add_path $INSTALL_DIR/bin"
      else
        add_to_path "$config_file" "export PATH=\"$INSTALL_DIR/bin:\$PATH\""
      fi
    fi
  fi
fi

if [[ -n "${GITHUB_ACTIONS:-}" && "$GITHUB_ACTIONS" == "true" ]]; then
  echo "$INSTALL_DIR/bin" >> "$GITHUB_PATH"
fi

echo ""
echo "$APP v$specific_version installed to $INSTALL_DIR/bin/$APP"
echo ""
echo "Start a new shell or run:"
echo "  export PATH=\"$INSTALL_DIR/bin:\$PATH\""
echo "  $APP --help"
