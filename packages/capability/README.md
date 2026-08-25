# capability/ — dynamic capability authority

English | [中文](README.zh.md)

Session-backed policy, exact-Agent leases, trusted Provider activation, and execution enforcement for optional model tools. The Controller keeps capability state in the Session log and makes a Provider's tool schema and guidance visible only while committed authority exists.

| Package | Role | ctx key |
|---|---|---|
| [`capability-controller/`](capability-controller/README.md) | Capability Registry, lease lifecycle, Provider activation, and guarded model tools | `ctx.capabilityController` |

The package includes the `provider-web` and `provider-shell` Loader entries. Application composition and the shipped `controlled-doc` preset remain owned by [`apps/cli`](../../apps/cli/README.md).
