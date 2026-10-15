"""LangChain / LangGraph driving the gateway through langchain-mcp-adapters: the tools an agent graph would be given,
invoked directly. No model is involved; the adapter is what is under test. Prints {"tools", "results"} as JSON.

The adapter turns a result with isError into an exception (ToolException) carrying the text, which a LangGraph agent
shows the model; both paths are recorded the same way here."""

import asyncio
import json
import os

from langchain_mcp_adapters.client import MultiServerMCPClient


def _text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return "\n".join(_text(v) for v in value)
    if isinstance(value, dict):
        return str(value.get("text", ""))
    return str(getattr(value, "text", value))


async def main() -> None:
    with open(os.environ["CONFORMANCE_SPEC"], encoding="utf-8") as f:
        spec = json.load(f)
    with open(os.environ["CONFORMANCE_CASES"], encoding="utf-8") as f:
        suite = json.load(f)
    client = MultiServerMCPClient(
        {"metamynd": {"transport": "stdio", "command": spec["command"], "args": spec["args"], "env": spec["env"]}}
    )
    async with client.session("metamynd") as session:
        from langchain_mcp_adapters.tools import load_mcp_tools

        tools = await load_mcp_tools(session)
        by_name = {t.name: t for t in tools}
        results = []
        for case in suite["cases"]:
            try:
                out = await by_name[suite["tool"]].ainvoke(case["args"])
                results.append({"id": case["id"], "isError": False, "text": _text(out)})
            except Exception as err:  # ToolException for an isError result
                results.append({"id": case["id"], "isError": True, "text": str(err)})
    print(json.dumps({"tools": sorted(by_name), "results": results}))


asyncio.run(main())
