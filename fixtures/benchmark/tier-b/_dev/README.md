# Development briefs

Briefs used while building the agent roles (M7.5a–c), to record and replay cassettes. They are not benchmark entries: tier B briefs (M8.2) are written and reviewed for neutrality by someone other than the maintainer, and the agents are never tuned against them.

Each `brief_NN/brief.json` holds the brief text, the workflow template, the deliverables and a budget. `engine/test/agents/dev-brief.test.ts` builds the project from it and runs the agents to the script gate; its cassettes live in `engine/test/agents/cassettes/<brief>/<pack>/`.
