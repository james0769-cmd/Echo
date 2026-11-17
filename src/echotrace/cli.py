"""Command-line entry point for EchoTrace.

Run ``echotrace --help`` for the command list; each subcommand has its own
``--help`` with the flags preserved from the former standalone tools.
"""

import argparse

from .commands import attribute, cer, compare_asr, demo, evaluate, export, minutes, prepare

COMMANDS = (prepare, cer, compare_asr, export, minutes, evaluate, attribute, demo)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="echotrace",
        description="Meeting minutes from recordings, with timestamped evidence.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for module in COMMANDS:
        module.register(sub)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    result = args.func(args)
    return 0 if result is None else int(result)


if __name__ == "__main__":
    raise SystemExit(main())
