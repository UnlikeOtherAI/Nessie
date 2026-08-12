#!/bin/sh
set -eu

usage() {
  echo "Usage: build-guest-initrd.sh --output <absolute-path> --bootstrap-token-stdin" >&2
  exit 64
}

output=""
read_token=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      [ "$#" -gt 1 ] || usage
      output="$2"
      shift 2
      ;;
    --bootstrap-token-stdin)
      read_token=1
      shift
      ;;
    *)
      usage
      ;;
  esac
done

[ -n "$output" ] && [ "$read_token" -eq 1 ] || usage
case "$output" in
  /*) ;;
  *) usage ;;
esac
[ ! -e "$output" ] && [ ! -L "$output" ] || {
  echo "initrd output already exists" >&2
  exit 1
}

parent=$(dirname "$output")
[ -d "$parent" ] && [ ! -L "$parent" ] || {
  echo "initrd parent is not a directory" >&2
  exit 1
}
[ "$(stat -f %u "$parent")" = "$(id -u)" ] && [ "$(stat -f %Lp "$parent")" = "700" ] || {
  echo "initrd parent must be owner-only" >&2
  exit 1
}

IFS= read -r token || [ -n "${token:-}" ] || {
  echo "missing bootstrap token" >&2
  exit 1
}
[ "${#token}" -eq 43 ] || {
  echo "invalid bootstrap token" >&2
  exit 1
}
case "$token" in
  *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*)
    echo "invalid bootstrap token" >&2
    exit 1
    ;;
esac
case "$(printf %s "$token" | cut -c43)" in
  A|E|I|M|Q|U|Y|c|g|k|o|s|w|0|4|8) ;;
  *)
    echo "invalid bootstrap token" >&2
    exit 1
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
guest_dir=$(CDPATH= cd -- "$script_dir/../../guest" && pwd)
tmp_dir=$(mktemp -d "$parent/.nessie-guest-initrd.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
umask 077
root_dir="$tmp_dir/root"
mkdir -p "$root_dir/etc/nessie"
chmod 700 "$root_dir/etc" "$root_dir/etc/nessie"
printf %s "$token" >"$root_dir/etc/nessie/bootstrap-token"
chmod 400 "$root_dir/etc/nessie/bootstrap-token"

(
  cd "$guest_dir"
  GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$root_dir/init" .
)
chmod 500 "$root_dir/init"
if ! (
  cd "$root_dir"
  find . -print | cpio -o -H newc --quiet >"$tmp_dir/guest-initrd"
) 2>"$tmp_dir/cpio.stderr"; then
  echo "guest initrd archive creation failed" >&2
  exit 1
fi
chmod 600 "$tmp_dir/guest-initrd"
mv "$tmp_dir/guest-initrd" "$output"
