## Pre-deployment
* Extend migration period to 30 days!
* Update ONBOARDING_PERIOD so that it's until 28 Jan 2027 (it was 154 from 27.08.2026); update constant, docs/NatSpec (incl. in scripts), tests accordingly
* For Sepolia deployment, use the DETH address on Sepolia instead of mainnet
* For Sepolia deployment, use the testnet specific configuration mentioned in the docs
* Refresh v1 names as a new one came in


## Post-deployment
* First register the namespaces
* Then registerNamesFor for migration
* Run the `build-safe-name-migration-batch.js` script to build the migration batch for the Safe transaction builder



COMPILE before deploying!!!!!!!!