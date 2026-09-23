# Standalone DeepWater native app

The `ios/` directory owns the standalone DeepWater SwiftUI client. Its home is
the research library; the New Research and Projects toolbar buttons are its
main entry points. Selecting research opens its report, evidence sources and
activity. Account contains team selection, people, plan, keys and webhook
settings.

This is a separate product client, not another implementation of Nessie's
navigation or its native shell. It talks to the existing DeepWater service and
uses one native `NavigationSplitView` across iPhone, iPad and Mac Catalyst.
See [the app guide](../ios/README.md) for supported platforms, build commands,
contracts, tests and the required OAuth domain association.
