"""SDK for Cinewright subprocess plugins (D32, M1.8b): JSON-RPC 2.0 on stdio."""

from cinewright_plugin_sdk.plugin import ERROR_CODES, Cancelled, Plugin, PluginError
from cinewright_plugin_sdk.rpc import serve

__all__ = ["ERROR_CODES", "Cancelled", "Plugin", "PluginError", "serve"]

__version__ = "0.0.0"
