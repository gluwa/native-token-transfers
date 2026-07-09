import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

/// Resolves a named secret to a private key hex. The seam that lets the worker source keys
/// from Azure Key Vault in production and from env vars in dev/tests.
export interface SecretStore {
  getSecret(name: string): Promise<string>;
}

/// Production: Azure Key Vault via managed identity (DefaultAzureCredential also picks up
/// env credentials locally). Secret values are the wallet private keys.
export class KeyVaultSecretStore implements SecretStore {
  private readonly client: SecretClient;

  constructor(vaultUrl: string, credential = new DefaultAzureCredential()) {
    this.client = new SecretClient(vaultUrl, credential);
  }

  async getSecret(name: string): Promise<string> {
    const secret = await this.client.getSecret(name);
    if (!secret.value) {
      throw new Error(`Key Vault secret "${name}" has no value`);
    }
    return secret.value;
  }
}

/// Dev/tests only: reads RELAYER_WALLET_<name> from the environment. Never use in prod —
/// raw keys in env defeat the point of Key Vault.
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async getSecret(name: string): Promise<string> {
    const value = this.env[`RELAYER_WALLET_${name}`];
    if (!value) {
      throw new Error(`env RELAYER_WALLET_${name} is not set`);
    }
    return value;
  }
}
