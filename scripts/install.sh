#!/usr/bin/env bash
set -euo pipefail

APP="git-bot"
REPO="Shailesh-714/git-bot"
INSTALL_DIR="$HOME/.$APP"

usage() {
  cat <<EOF
$APP Installer

Usage: install.sh [options]

Options:
  -h, --help              Display this help message
  -v, --version <version> Install a specific version (e.g., 0.1.0)
      --no-modify-path    Do not modify shell config files

Examples:
  curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash
  curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash -s -- --version 0.1.0
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
  local output="${2:-/dev/stdout}"
  # Retry on any error (including 403s/429s) with a short backoff.
  curl -fsSL \
    --retry 3 \
    --retry-delay 2 \
    --retry-all-errors \
    -H "User-Agent: ${APP}-installer" \
    "$url" -o "$output"
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
  linux | darwin)
    ext="tar.gz"
    ;;
  windows)
    ext="zip"
    ;;
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

# --- Resolve version / URL ---------------------------------------------------

if [[ -z "$requested_version" ]]; then
  url="https://github.com/$REPO/releases/latest/download/$filename"
  api_url="https://api.github.com/repos/$REPO/releases/latest"
  specific_version=$(download "$api_url" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')
  if [[ -z "$specific_version" ]]; then
    echo "Error: Failed to fetch latest version information" >&2
    echo "Try specifying a version explicitly:" >&2
    echo "  curl -fsSL https://cdn.jsdelivr.net/gh/$REPO@main/scripts/install.sh | bash -s -- --version 0.1.0" >&2
    exit 1
  fi
else
  requested_version="${requested_version#v}"
  specific_version="$requested_version"
  url="https://github.com/$REPO/releases/download/v${specific_version}/$filename"
fi

# --- Download and install ----------------------------------------------------

echo "Installing $APP v$specific_version ($os/$arch)..."

tmp_dir="${TMPDIR:-/tmp}/${APP}_install_$$"
mkdir -p "$tmp_dir"
trap 'rm -rf "$tmp_dir"' EXIT

if ! download "$url" "$tmp_dir/$filename"; then
  echo "Error: Failed to download $url" >&2
  echo "This is usually a temporary GitHub rate-limit. Wait a minute and try again," >&2
  echo "or install a specific version with --version." >&2
  exit 1
fi

if [[ "$ext" == "tar.gz" ]]; then
  tar -xzf "$tmp_dir/$filename" -C "$tmp_dir"
else
  unzip -q "$tmp_dir/$filename" -d "$tmp_dir"
fi

# The archive contains a single root directory named "git-bot"
rm -rf "$INSTALL_DIR"
mv "$tmp_dir/$APP" "$INSTALL_DIR"

chmod +x "$INSTALL_DIR/bin/$APP"

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
  current_shell=$(basename "$SHELL")
  config_file=""

  case "$current_shell" in
    zsh)
      config_file="${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    bash)
      if [[ -f "$HOME/.bashrc" ]]; then
        config_file="$HOME/.bashrc"
      elif [[ -f "$HOME/.bash_profile" ]]; then
        config_file="$HOME/.bash_profile"
      else
        config_file="$HOME/.profile"
      fi
      ;;
    fish)
      config_file="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      ;;
    *)
      config_file="$HOME/.profile"
      ;;
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
