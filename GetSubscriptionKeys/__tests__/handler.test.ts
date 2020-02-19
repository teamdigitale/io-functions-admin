// tslint:disable:no-any

import { ApiManagementClient } from "@azure/arm-apimanagement";
import { SubscriptionGetResponse } from "@azure/arm-apimanagement/esm/models";
import { RestError } from "@azure/ms-rest-js";
import * as msRestNodeAuth from "@azure/ms-rest-nodeauth";

import { NonEmptyString } from "italia-ts-commons/lib/strings";
import { GetSubscriptionKeysHandler } from "../handler";

const mockLoginWithServicePrincipalSecret = jest.spyOn(
  msRestNodeAuth,
  "loginWithServicePrincipalSecret"
);
const aValidSubscriptionId = "valid-subscription-id" as NonEmptyString;
const aNotExistingSubscriptionId = "not-existing-subscription-id" as NonEmptyString;
const aBreakingApimSubscriptionId = "broken-subscription-id" as NonEmptyString;

jest.mock("@azure/arm-apimanagement");
const mockApiManagementClient = ApiManagementClient as jest.Mock;
const mockLog = jest.fn();
const mockGetToken = jest.fn();

const mockedSubscription = {
  primaryKey: "primary-key",
  secondaryKey: "seconday-key"
} as SubscriptionGetResponse;
mockApiManagementClient.mockImplementation(() => ({
  subscription: {
    get: (_, __, subscriptionId) => {
      if (subscriptionId === aValidSubscriptionId) {
        return Promise.resolve(mockedSubscription);
      }
      if (subscriptionId === aBreakingApimSubscriptionId) {
        return Promise.reject(new RestError("generic error", "", 500));
      }
      if (subscriptionId === aNotExistingSubscriptionId) {
        return Promise.reject(new RestError("not found", "", 404));
      }
      return fail(Error("The provided subscription id value is not handled"));
    }
  }
}));
mockLoginWithServicePrincipalSecret.mockImplementation(() => {
  return Promise.resolve({ getToken: mockGetToken });
});
mockGetToken.mockImplementation(() => {
  return Promise.resolve(undefined);
});

const mockedValidToken = {
  expiresOn: Date.now() + 86400000, // tomorrow
  loginCreds: {} as any,
  token: {
    accessToken: "access-token",
    tokenType: "token-type"
  }
};
const mockedExpiredToken = {
  expiresOn: Date.now() - 86400000, // yesterday
  loginCreds: {} as any,
  token: {
    accessToken: "access-token",
    tokenType: "token-type"
  }
};
const mockedContext = { log: { error: mockLog } };

describe("GetSubscriptionKeysHandler", () => {
  afterEach(() => {
    mockLoginWithServicePrincipalSecret.mockClear();
  });

  it("should get new credentials with service principal secret where the token is missing or expired", async () => {
    // missing token
    const getSubscriptionKeysHandlerWithoutToken = GetSubscriptionKeysHandler(
      undefined
    );
    await getSubscriptionKeysHandlerWithoutToken(
      mockedContext as any,
      undefined as any,
      aValidSubscriptionId
    );
    expect(mockLoginWithServicePrincipalSecret).toHaveBeenCalledTimes(1);
    mockLoginWithServicePrincipalSecret.mockClear();

    // expired token
    const getSubscriptionKeysHandlerWithExpiredToken = GetSubscriptionKeysHandler(
      mockedExpiredToken
    );
    await getSubscriptionKeysHandlerWithExpiredToken(
      mockedContext as any,
      undefined as any,
      aValidSubscriptionId
    );
    expect(mockLoginWithServicePrincipalSecret).toHaveBeenCalledTimes(1);
  });

  it("should reuse the same credentials where the token is valid", async () => {
    const getSubscriptionKeysHandlerWithExpiredToken = GetSubscriptionKeysHandler(
      mockedValidToken
    );
    await getSubscriptionKeysHandlerWithExpiredToken(
      mockedContext as any,
      undefined as any,
      aValidSubscriptionId
    );
    expect(mockLoginWithServicePrincipalSecret).toHaveBeenCalledTimes(0);
  });

  it("should return a not found error response if the subscription is not found", async () => {
    const getSubscriptionKeysHandler = GetSubscriptionKeysHandler(undefined);
    const response = await getSubscriptionKeysHandler(
      mockedContext as any,
      undefined as any,
      aNotExistingSubscriptionId
    );
    expect(response.kind).toEqual("IResponseErrorNotFound");
  });

  it("should return a not found error response if the API management client returns an error", async () => {
    const getSubscriptionKeysHandler = GetSubscriptionKeysHandler(undefined);
    const response = await getSubscriptionKeysHandler(
      mockedContext as any,
      undefined as any,
      aBreakingApimSubscriptionId
    );
    expect(response.kind).toEqual("IResponseErrorInternal");
  });
});
