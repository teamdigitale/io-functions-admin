// tslint:disable: no-any

import { IFunctionContext } from "durable-functions/lib/src/classes";
import { UserDataProcessingStatusEnum } from "io-functions-commons/dist/generated/definitions/UserDataProcessingStatus";
import {
  mockOrchestratorCallActivity,
  mockOrchestratorCallActivityWithRetry,
  mockOrchestratorContext
} from "../../__mocks__/durable-functions";
import { aArchiveInfo, aUserDataProcessing } from "../../__mocks__/mocks";
import { ActivityResultSuccess as ExtractUserDataActivityResultSuccess } from "../../ExtractUserDataActivity/handler";
import { ActivityResultSuccess as SendUserDataDownloadMessageActivityResultSuccess } from "../../SendUserDataDownloadMessageActivity/handler";
import {
  ActivityFailure,
  getHandler,
  InvalidInputFailure,
  OrchestratorSuccess
} from "../handler";

import { Millisecond } from "italia-ts-commons/lib/units";
import { ActivityResultSuccess as SetUserDataProcessingStatusActivityResultSuccess } from "../../SetUserDataProcessingStatusActivity/handler";

const DELAY = 1 as Millisecond;

const aNonSuccess = "any non-success value";

const setUserDataProcessingStatusActivity = jest.fn().mockImplementation(() =>
  SetUserDataProcessingStatusActivityResultSuccess.encode({
    kind: "SUCCESS",
    value: aUserDataProcessing
  })
);
const extractUserDataActivity = jest.fn().mockImplementation(() =>
  ExtractUserDataActivityResultSuccess.encode({
    kind: "SUCCESS",
    value: aArchiveInfo
  })
);
const sendUserDataDownloadMessageActivity = jest
  .fn()
  .mockImplementation(() =>
    SendUserDataDownloadMessageActivityResultSuccess.encode({ kind: "SUCCESS" })
  );

// A mock implementation proxy for df.callActivity/df.df.callActivityWithRetry that routes each call to the correct mock implentation
const switchMockImplementation = (name: string, ...args: readonly unknown[]) =>
  (name === "setUserDataProcessingStatusActivity"
    ? setUserDataProcessingStatusActivity
    : name === "extractUserDataActivity"
    ? extractUserDataActivity
    : name === "sendUserDataDownloadMessageActivity"
    ? sendUserDataDownloadMessageActivity
    : jest.fn())(name, ...args);

// I assign switchMockImplementation to both because
// I don't want tests to depend on implementation details
// such as which activity is called with retry and which is not
mockOrchestratorCallActivity.mockImplementation(switchMockImplementation);
mockOrchestratorCallActivityWithRetry.mockImplementation(
  switchMockImplementation
);

/**
 * Util function that takes an orchestrator and executes each step until is done
 * @param orch an orchestrator
 *
 * @returns the last value yielded by the orchestrator
 */
const consumeOrchestrator = (orch: any) => {
  // tslint:disable-next-line: no-let
  let prevValue: unknown;
  while (true) {
    const { done, value } = orch.next(prevValue);
    if (done) {
      return value;
    }
    prevValue = value;
  }
};

// just a convenient cast, good for every test case
const context = (mockOrchestratorContext as unknown) as IFunctionContext;

const handler = getHandler(DELAY);

// tslint:disable-next-line: no-big-function
describe("handler(DELAY)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should fail on invalid input", () => {
    const document = "invalid";

    const result = consumeOrchestrator(handler(context, document));

    expect(InvalidInputFailure.decode(result).isRight()).toBe(true);
    expect(setUserDataProcessingStatusActivity).not.toHaveBeenCalled();
    expect(extractUserDataActivity).not.toHaveBeenCalled();
    expect(sendUserDataDownloadMessageActivity).not.toHaveBeenCalled();
  });

  it.each`
    name        | status
    ${"WIP"}    | ${UserDataProcessingStatusEnum.WIP}
    ${"CLOSED"} | ${UserDataProcessingStatusEnum.CLOSED}
  `("should skip if the status is $name", ({ status }) => {
    const document = {
      ...aUserDataProcessing,
      status
    };

    const result = consumeOrchestrator(handler(context, document));

    expect(InvalidInputFailure.decode(result).isRight()).toBe(true);
    expect(setUserDataProcessingStatusActivity).not.toHaveBeenCalled();
    expect(extractUserDataActivity).not.toHaveBeenCalled();
    expect(sendUserDataDownloadMessageActivity).not.toHaveBeenCalled();
  });

  it("should success if everything goes well", () => {
    const document = {
      ...aUserDataProcessing,
      status: UserDataProcessingStatusEnum.PENDING
    };

    const result = consumeOrchestrator(handler(context, document));

    expect(OrchestratorSuccess.decode(result).isRight()).toBe(true);
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalledTimes(2);
    // first, set as WIP
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalledWith(
      expect.any(String),
      {
        currentRecord: expect.any(Object),
        nextStatus: UserDataProcessingStatusEnum.WIP
      }
    );
    // then, set as CLOSED
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalledWith(
      expect.any(String),
      {
        currentRecord: expect.any(Object),
        nextStatus: UserDataProcessingStatusEnum.CLOSED
      }
    );
    expect(extractUserDataActivity).toHaveBeenCalled();
    expect(sendUserDataDownloadMessageActivity).toHaveBeenCalled();
  });

  it("should set as FAILED when data extraction fails", () => {
    extractUserDataActivity.mockImplementationOnce(() => aNonSuccess);

    const document = {
      ...aUserDataProcessing,
      status: UserDataProcessingStatusEnum.PENDING
    };

    const result = consumeOrchestrator(handler(context, document));

    expect(ActivityFailure.decode(result).isRight()).toBe(true);
    expect(result.activityName).toBe("extractUserDataActivity");
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalled(); // any times, at least one
    // then, set as FAILED
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalledWith(
      expect.any(String),
      {
        currentRecord: expect.any(Object),
        nextStatus: UserDataProcessingStatusEnum.FAILED
      }
    );
    expect(extractUserDataActivity).toHaveBeenCalled();
    expect(sendUserDataDownloadMessageActivity).not.toHaveBeenCalled();
  });

  it("should set as FAILED when send message fails", () => {
    sendUserDataDownloadMessageActivity.mockImplementationOnce(
      () => aNonSuccess
    );

    const document = {
      ...aUserDataProcessing,
      status: UserDataProcessingStatusEnum.PENDING
    };

    const result = consumeOrchestrator(handler(context, document));

    expect(ActivityFailure.decode(result).isRight()).toBe(true);
    expect(result.activityName).toBe("sendUserDataDownloadMessageActivity");
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalled(); // any times, at least one
    // then, set as FAILED
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalledWith(
      expect.any(String),
      {
        currentRecord: expect.any(Object),
        nextStatus: UserDataProcessingStatusEnum.FAILED
      }
    );
    expect(extractUserDataActivity).toHaveBeenCalled();
    expect(sendUserDataDownloadMessageActivity).toHaveBeenCalled();
  });

  it("should set as FAILED when status update to WIP fails", () => {
    setUserDataProcessingStatusActivity.mockImplementationOnce(
      () => aNonSuccess
    );

    const document = {
      ...aUserDataProcessing,
      status: UserDataProcessingStatusEnum.PENDING
    };

    const result = consumeOrchestrator(handler(context, document));

    expect(ActivityFailure.decode(result).isRight()).toBe(true);
    expect(result.activityName).toBe("setUserDataProcessingStatusActivity");
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalled(); // any times, at least one
    // then, set as FAILED
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalledWith(
      expect.any(String),
      {
        currentRecord: expect.any(Object),
        nextStatus: UserDataProcessingStatusEnum.FAILED
      }
    );
    expect(extractUserDataActivity).not.toHaveBeenCalled();
    expect(sendUserDataDownloadMessageActivity).not.toHaveBeenCalled();
  });

  it("should set as FAILED when status update to WIP fails", () => {
    setUserDataProcessingStatusActivity.mockImplementationOnce(
      () => aNonSuccess
    );

    const document = {
      ...aUserDataProcessing,
      status: UserDataProcessingStatusEnum.PENDING
    };

    const result = consumeOrchestrator(handler(context, document));

    expect(ActivityFailure.decode(result).isRight()).toBe(true);
    expect(result.activityName).toBe("setUserDataProcessingStatusActivity");
    expect(result.extra).toEqual({
      status: UserDataProcessingStatusEnum.WIP
    });
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalled(); // any times, at least one
    // then, set as FAILED
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalledWith(
      expect.any(String),
      {
        currentRecord: expect.any(Object),
        nextStatus: UserDataProcessingStatusEnum.FAILED
      }
    );
    expect(extractUserDataActivity).not.toHaveBeenCalled();
    expect(sendUserDataDownloadMessageActivity).not.toHaveBeenCalled();
  });

  it("should set as FAILED when status update to CLOSED fails", () => {
    // the first time is called is for WIP
    setUserDataProcessingStatusActivity.mockImplementationOnce(() =>
      SetUserDataProcessingStatusActivityResultSuccess.encode({
        kind: "SUCCESS",
        value: aUserDataProcessing
      })
    );
    setUserDataProcessingStatusActivity.mockImplementationOnce(
      () => aNonSuccess
    );

    const document = {
      ...aUserDataProcessing,
      status: UserDataProcessingStatusEnum.PENDING
    };

    const result = consumeOrchestrator(handler(context, document));

    expect(ActivityFailure.decode(result).isRight()).toBe(true);
    expect(result.activityName).toBe("setUserDataProcessingStatusActivity");
    expect(result.extra).toEqual({
      status: UserDataProcessingStatusEnum.CLOSED
    });
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalled(); // any times, at least one
    // then, set as FAILED
    expect(setUserDataProcessingStatusActivity).toHaveBeenCalledWith(
      expect.any(String),
      {
        currentRecord: expect.any(Object),
        nextStatus: UserDataProcessingStatusEnum.FAILED
      }
    );
    expect(extractUserDataActivity).toHaveBeenCalled();
    expect(sendUserDataDownloadMessageActivity).toHaveBeenCalled();
  });
});
