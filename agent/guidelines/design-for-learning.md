# Design for learning, not completeness

Early work must help us discover the problem and test our understanding. Do not design a complete system upfront.

## Understand the domain first

The domain is the problem area and its concepts, rules, and relationships.

- Start with a concrete use case and the question that the experiment must answer.
- Describe the concepts, responsibilities, and relationships needed for that use case.
- Separate confirmed requirements from assumptions. Ask about uncertainties that materially affect the design.
- Do not invent domain concepts to fit a familiar architecture or design pattern.
- Keep this discussion short and concrete. Do not turn it into a full design exercise.

## Build the smallest useful experiment

- Propose the smallest end-to-end path that tests the current idea.
- Include only the components and behavior needed for that path.
- Prefer direct code over abstractions for hypothetical future needs.
- Do not add rollback systems, application lifecycle frameworks, or session management unless the current use case requires them.
- Preserve existing safety rules. A small experiment does not justify unsafe changes.

## Keep scope explicit

- For each proposed component, explain which current requirement it serves.
- If a component serves only a possible future need, leave it out.
- Mention useful future features separately. Do not include them in the initial design or implementation without approval.
- After testing, revisit the domain model and architecture using what we learned.

The default is to leave things out until evidence shows that we need them, not to build them because they sound useful.
