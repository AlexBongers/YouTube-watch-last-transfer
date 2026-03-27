"""CLI entry point for the YouTube Watch Later Transfer tool."""

import argparse
import logging
import sys

from . import config

logger = logging.getLogger(__name__)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="yt-transfer",
        description=(
            "YouTube Watch Later Transfer — move videos between playlists.\n\n"
            "NOTE: The YouTube Data API cannot access the Watch Later (Later Bekijken)\n"
            "playlist. Use 'transfer-takeout' with a Google Takeout export for that."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--secrets",
        default=config.CLIENT_SECRETS_FILE,
        metavar="FILE",
        help="Path to OAuth client secrets JSON (default: %(default)s)",
    )
    parser.add_argument(
        "--token",
        default=config.TOKEN_FILE,
        metavar="FILE",
        help="Path to cached OAuth token JSON (default: %(default)s)",
    )
    parser.add_argument(
        "--log-level",
        default=config.LOG_LEVEL,
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging verbosity (default: %(default)s)",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # ------------------------------------------------------------------
    # transfer-takeout
    # ------------------------------------------------------------------
    sub_takeout = subparsers.add_parser(
        "transfer-takeout",
        help="Transfer videos from a Google Takeout export to a playlist",
        description=(
            "Parse a Google Takeout CSV or HTML export and add the videos\n"
            "to the specified target playlist.\n\n"
            "How to get the export:\n"
            "  1. Go to https://takeout.google.com/\n"
            "  2. Select 'YouTube and YouTube Music'\n"
            "  3. Under 'YouTube and YouTube Music data included' choose\n"
            "     'Playlists' and make sure 'Watch later' is included.\n"
            "  4. Download and extract the archive.\n"
            "  5. Find the CSV file in 'YouTube and YouTube Music/playlists/'."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub_takeout.add_argument("takeout_file", help="Path to the Takeout CSV or HTML file")
    sub_takeout.add_argument(
        "target_playlist",
        help="ID of the destination playlist (use 'list-playlists' to find it)",
    )
    sub_takeout.add_argument(
        "--delay",
        type=float,
        default=config.API_CALL_DELAY,
        help="Seconds between API calls (default: %(default)s)",
    )

    # ------------------------------------------------------------------
    # transfer-playlist
    # ------------------------------------------------------------------
    sub_pl = subparsers.add_parser(
        "transfer-playlist",
        help="Transfer videos from one regular playlist to another",
        description=(
            "Transfer all videos from SOURCE_PLAYLIST to TARGET_PLAYLIST "
            "using the YouTube Data API.\n\n"
            "⚠  This does NOT work for the Watch Later playlist (WL).\n"
            "   Use 'transfer-takeout' for Watch Later."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub_pl.add_argument("source_playlist", help="ID of the source playlist")
    sub_pl.add_argument("target_playlist", help="ID of the destination playlist")
    sub_pl.add_argument(
        "--delay",
        type=float,
        default=config.API_CALL_DELAY,
        help="Seconds between API calls (default: %(default)s)",
    )

    # ------------------------------------------------------------------
    # list-playlists
    # ------------------------------------------------------------------
    subparsers.add_parser(
        "list-playlists",
        help="List all playlists in your account",
    )

    # ------------------------------------------------------------------
    # create-playlist
    # ------------------------------------------------------------------
    sub_create = subparsers.add_parser(
        "create-playlist",
        help="Create a new playlist",
    )
    sub_create.add_argument("title", help="Title for the new playlist")
    sub_create.add_argument("--description", default="", help="Optional description")
    sub_create.add_argument(
        "--public",
        action="store_true",
        help="Make the playlist public (default: private)",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    config.configure_logging(args.log_level)

    # Lazy imports so that tests importing main.py don't need credentials
    from . import auth, transfer, youtube_api

    try:
        service = auth.get_youtube_service(
            client_secrets_file=args.secrets,
            token_file=args.token,
        )
    except FileNotFoundError as exc:
        logger.error("%s", exc)
        return 1

    if args.command == "transfer-takeout":
        added, skipped = transfer.transfer_from_takeout(
            service,
            args.takeout_file,
            args.target_playlist,
            delay=args.delay,
        )
        print(f"\n✅  Transfer complete — added: {added}, skipped: {skipped}")

    elif args.command == "transfer-playlist":
        try:
            added, skipped = transfer.transfer_between_playlists(
                service,
                args.source_playlist,
                args.target_playlist,
                delay=args.delay,
            )
        except ValueError as exc:
            logger.error("%s", exc)
            return 1
        print(f"\n✅  Transfer complete — added: {added}, skipped: {skipped}")

    elif args.command == "list-playlists":
        playlists = youtube_api.list_playlists(service)
        if not playlists:
            print("No playlists found.")
            return 0
        print(f"{'ID':<35} {'Title'}")
        print("-" * 70)
        for pl in playlists:
            pl_id = pl["id"]
            title = pl["snippet"]["title"]
            count = pl.get("contentDetails", {}).get("itemCount", "?")
            print(f"{pl_id:<35} {title} ({count} videos)")

    elif args.command == "create-playlist":
        pl = youtube_api.create_playlist(
            service,
            title=args.title,
            description=args.description,
            private=not args.public,
        )
        print(f"✅  Created playlist '{pl['snippet']['title']}' — ID: {pl['id']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
