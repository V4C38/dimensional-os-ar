"""Read the effective transport using the selected DimOS interpreter."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from dimos.cli.commands.lifecycle import DEFAULT_CONFIG_PATH
from dimos.core.coordination.blueprint_config.parser import BlueprintConfigParser


def main() -> None:
    config_path = Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else DEFAULT_CONFIG_PATH
    settings = BlueprintConfigParser.preparse_global_config(config_path=config_path)
    print(json.dumps(settings["transport"]))


if __name__ == "__main__":
    main()
