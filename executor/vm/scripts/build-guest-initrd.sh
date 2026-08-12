#!/bin/sh
set -eu

usage() {
  echo "Usage: build-guest-initrd.sh --output <absolute-path> --bootstrap-token-stdin [--coding-session-proof-stdin]" >&2
  exit 64
}

output=""
read_token=0
read_coding_proof=0
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
    --coding-session-proof-stdin)
      read_coding_proof=1
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

expected_input_length=43
[ "$read_coding_proof" -eq 0 ] || expected_input_length=86
input=$(dd bs=1 count=$((expected_input_length + 1)) 2>/dev/null)
[ "${#input}" -eq "$expected_input_length" ] || {
  echo "missing bootstrap token" >&2
  exit 1
}
token=$(printf %s "$input" | cut -c1-43)
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

coding_proof=""
if [ "$read_coding_proof" -eq 1 ]; then
  coding_proof=$(printf %s "$input" | cut -c44-86)
  case "$coding_proof" in
    *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*)
      echo "invalid coding session proof" >&2
      exit 1
      ;;
  esac
  case "$(printf %s "$coding_proof" | cut -c43)" in
    A|E|I|M|Q|U|Y|c|g|k|o|s|w|0|4|8) ;;
    *)
      echo "invalid coding session proof" >&2
      exit 1
      ;;
  esac
fi

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
if [ "$read_coding_proof" -eq 1 ]; then
  printf %s "$coding_proof" >"$root_dir/etc/nessie/coding-session-proof"
  chmod 400 "$root_dir/etc/nessie/coding-session-proof"
fi

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
