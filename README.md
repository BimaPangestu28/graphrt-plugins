# graphrt-plugins

## Overview
A collection of plugins for [graphrt](https://github.com/BimaPangestu28/graphrt). Each directory is one
plugin with its own `graphrt-plugin.json`.

## Plugins
| Plugin | Description |
|--------|-------------|
| [gmaps](gmaps/) | Search Google Maps (headless browser) and extract business phone numbers |

## Usage
```bash
graphrt run <workflow.yaml> --plugins /path/to/graphrt-plugins
# or install one plugin
graphrt plugin install ./gmaps
```
See each plugin's README for setup.

## License
Apache-2.0
