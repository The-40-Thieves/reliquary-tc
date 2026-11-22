---
type: Fixed
---
- **The leader failover test now reports why it failed.** Its inner wait for the follower to promote
  was as long as the test's own timeout on Windows, so a follower that never promoted showed up as a
  bare timeout. The test timeout now covers the setup and the whole wait, and the failure names the
  follower, its exit state, the elapsed time and the processes seen in the embed log. Test only.
