# Watchdog research evidence — user-provided social posts

These posts were supplied in project discussion on 2026-07-14. Preserve them as inspiration and demo-story evidence. They have **not** been independently verified or archived; do not claim a quote, date, or product behavior is verified without checking the original post before public use.

## Subagents are hard to observe

### Sahaj — [@iamsahaj_xyz](https://x.com/iamsahaj_xyz)

> why not use subagents?
>
> subagents are inherently complex and hard to observe

## Scaling agent work becomes messy

### Rhys — [@RhysSullivan](https://x.com/RhysSullivan)

> i'm at a weird point with agentic development where if i go slowly, use agents mainly as context gathering, i love shipping and am proud of the product
>
> the moment i try to do more with agents though things become a mess. theoretically loops solve this but i am doubtful

## Runaway fan-out

### jun — [@hyojun_at](https://x.com/hyojun_at)

> 5.6 Ultra is one of the stupidest agent harness shit i've ever seen
> - main agent spawns 8 subagents
> - each subagent spawns 4 subagents
> - each subagent spawns 5 subagents
> - more than 200 agents are running for a simple research task
>
> result:

The supplied text labels this post as July 10; the result itself was not included.

## Hidden model / quota cost

### Eidzoku — [@evi77ain](https://x.com/evi77ain)

> There's a flaw in Codex's (or should I say ChatGPT's?) subagent orchestration.
>
> The spawn_agent tool doesn't let you choose the model or reasoning effort.
>
> Therefore, every time 5.6 Sol Ultra spawns a subagent, you're getting another Sol Ultra instance.
>
> That's why your quota gets drained so fast.

## Model routing as a user-controlled strategy

### Simon Willison — [@simonw](https://x.com/simonw)

> The most interesting Fable tip I've heard so far is to let the model use its own judgement as much as possible
>
> I told it "For all coding tasks use your judgement to decide an appropriate lower power model and run that in a subagent" and it seems to be saving a lot of tokens

The supplied text labels this post as July 4.

## Existing adjacent Pi solution

### Can. — [@lumendriada](https://x.com/lumendriada)

> i built a new pi subagent extension that is more codex-like; main agent can easily watch, do follow-ups and it also gives observability through floating pi panes. now i can dig what those subagents up to.
>
> feels good man.

Project context: the user identified this author as the developer behind Herdr. This is adjacent competition/inspiration: floating panes and follow-ups for Pi, rather than Watchdog's intended cross-harness loop/subagent control surface.

## Fork-context model mismatch

### banteg — [@banteg](https://x.com/banteg)

> if you use sol as a subagent orchestrator, there is currently quite a huge footgun you should keep in mind.
>
> even if you explicitly ask to spawn luna subagents, the default behavior is to fork off a conversation (fork_turns: all) prevents switching the model.
>
> to actually use another model, codex needs to override fork_turns to none or a positive number when spawning subagents.
>
> currently the subagent model and reasoning effort do not show up in the gui, so it can go unnoticed.

Use this as the clearest Watchdog demo narrative after independently verifying current behavior: requested versus effective model, reasoning effort, context/fork strategy, and token/cost impact.
