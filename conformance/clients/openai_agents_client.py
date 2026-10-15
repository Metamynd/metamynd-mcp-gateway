"""The OpenAI Agents SDK (Python) driving the gateway: its MCPServerStdio lists the tools and calls them, as an agent
would. No model is involved; the SDK's MCP client is what is under test. Prints {"tools", "results"} as JSON."""

import asyncio
import json
import os

from agents.mcp import MCPServerStdio


async def main() -> None:
    with open(os.environ["CONFORMANCE_SPEC"], encoding="utf-8") as f:
        spec = json.load(f)
    with open(os.environ["CONFORMANCE_CASES"], encoding="utf-8") as f:
        suite = json.load(f)
    server = MCPServerStdio(
        params={"command": spec["command"], "args": spec["args"], "env": spec["env"]},
        client_session_timeout_seconds=30,
    )
    async with server:
        tools = [t.name for t in await server.list_tools()]
        results = []
        for case in suite["cases"]:
            r = await server.call_tool(suite["tool"], case["args"])
            text = "\n".join(getattr(p, "text", "") or "" for p in r.content)
            results.append({"id": case["id"], "isError": bool(r.isError), "text": text})
    print(json.dumps({"tools": tools, "results": results}))


asyncio.run(main())
