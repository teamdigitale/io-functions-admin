import { IFunctionContext } from "durable-functions/lib/src/classes";
import { isLeft } from "fp-ts/lib/Either";
import { UserDataProcessingStatusEnum } from "io-functions-commons/dist/generated/definitions/UserDataProcessingStatus";
import { UserDataProcessing } from "io-functions-commons/dist/src/models/user_data_processing";
import * as t from "io-ts";
import { readableReport } from "italia-ts-commons/lib/reporters";

const logPrefix = "UserDataDownloadOrchestrator";

// models the subset of UserDataProcessing documents that this orchestrator accepts
export type ProcessableUserDataProcessing = t.TypeOf<
  typeof ProcessableUserDataProcessing
>;
export const ProcessableUserDataProcessing = t.intersection([
  UserDataProcessing,
  t.interface({
    status: t.union([
      t.literal(UserDataProcessingStatusEnum.PENDING),
      t.literal(UserDataProcessingStatusEnum.FAILED)
    ])
  })
]);

const CosmosDbDocumentCollection = t.readonlyArray(t.readonly(t.UnknownRecord));
type CosmosDbDocumentCollection = t.TypeOf<typeof CosmosDbDocumentCollection>;

export const handler = function*(
  context: IFunctionContext,
  input: unknown
): IterableIterator<unknown> {
  const subTasks = CosmosDbDocumentCollection.decode(input)
    .fold(
      err => {
        throw Error(
          `${logPrefix}: cannot decode input [${readableReport(err)}]`
        );
      },
      documents =>
        documents.map(doc => ProcessableUserDataProcessing.decode(doc))
    )
    .reduce(
      (documents, maybeProcessable) => {
        if (isLeft(maybeProcessable)) {
          context.log.warn(
            `${logPrefix}: skipping document [${readableReport(
              maybeProcessable.value
            )}]`
          );
          return documents;
        }
        return [...documents, maybeProcessable.value];
      },
      [] as readonly ProcessableUserDataProcessing[]
    )
    .map(processableDoc =>
      context.df.callSubOrchestrator(
        "UserDataDownloadSubOrchestrator",
        processableDoc
      )
    );

  context.log.info(
    `${logPrefix}: processing ${subTasks.length} document${
      subTasks.length === 1 ? "" : "s"
    }`
  );
  yield context.df.Task.all(subTasks);
};
