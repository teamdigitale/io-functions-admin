/**
 * This activity extracts all the data about a user contained in our db.
 */

import * as t from "io-ts";

import { sequenceT } from "fp-ts/lib/Apply";
import { array } from "fp-ts/lib/Array";
import { Either, left, toError } from "fp-ts/lib/Either";
import { none, Option, some } from "fp-ts/lib/Option";
import {
  fromEither,
  TaskEither,
  taskEither,
  taskEitherSeq,
  taskify,
  tryCatch
} from "fp-ts/lib/TaskEither";

import { Context } from "@azure/functions";

import { BlobService } from "azure-storage";
import { QueryError } from "documentdb";
import { MessageContent } from "io-functions-commons/dist/generated/definitions/MessageContent";
import {
  RetrievedMessageWithContent,
  RetrievedMessageWithoutContent
} from "io-functions-commons/dist/src/models/message";
import { RetrievedMessageStatus } from "io-functions-commons/dist/src/models/message_status";
import { RetrievedNotification } from "io-functions-commons/dist/src/models/notification";
import { RetrievedNotificationStatus } from "io-functions-commons/dist/src/models/notification_status";
import { RetrievedProfile } from "io-functions-commons/dist/src/models/profile";
import {
  IResultIterator,
  iteratorToArray
} from "io-functions-commons/dist/src/utils/documentdb";
import { readableReport } from "italia-ts-commons/lib/reporters";
import { FiscalCode, NonEmptyString } from "italia-ts-commons/lib/strings";
import { MessageModel } from "../utils/extensions/models/message";
import { MessageStatusModel } from "../utils/extensions/models/message_status";
import { NotificationModel } from "../utils/extensions/models/notification";
import { NotificationStatusModel } from "../utils/extensions/models/notification_status";
import { ProfileModel } from "../utils/extensions/models/profile";

// Activity input
export const ActivityInput = t.interface({
  backupFolder: NonEmptyString,
  fiscalCode: FiscalCode
});
export type ActivityInput = t.TypeOf<typeof ActivityInput>;

// Activity success result
export const ActivityResultSuccess = t.interface({
  kind: t.literal("SUCCESS")
});
export type ActivityResultSuccess = t.TypeOf<typeof ActivityResultSuccess>;

// Activity failed because of invalid input
export const InvalidInputFailure = t.interface({
  kind: t.literal("INVALID_INPUT_FAILURE"),
  reason: t.string
});
export type InvalidInputFailure = t.TypeOf<typeof InvalidInputFailure>;

// Activity failed because of an error on a query
export const QueryFailure = t.intersection([
  t.interface({
    kind: t.literal("QUERY_FAILURE"),
    reason: t.string
  }),
  t.partial({ query: t.string })
]);
export type QueryFailure = t.TypeOf<typeof QueryFailure>;

// activity failed for user not found
export const UserNotFound = t.interface({
  kind: t.literal("USER_NOT_FOUND_FAILURE")
});
export type UserNotFound = t.TypeOf<typeof UserNotFound>;

// activity failed while deleting a document from the db
export const DocumentDeleteFailure = t.interface({
  kind: t.literal("DELETE_FAILURE"),
  reason: t.string
});
export type DocumentDeleteFailure = t.TypeOf<typeof DocumentDeleteFailure>;

// activity failed while creating a new blob on storage
export const BlobCreationFailure = t.interface({
  kind: t.literal("BLOB_FAILURE"),
  reason: t.string
});
export type BlobCreationFailure = t.TypeOf<typeof BlobCreationFailure>;

export const ActivityResultFailure = t.taggedUnion("kind", [
  UserNotFound,
  QueryFailure,
  InvalidInputFailure,
  BlobCreationFailure,
  DocumentDeleteFailure
]);
export type ActivityResultFailure = t.TypeOf<typeof ActivityResultFailure>;

export const ActivityResult = t.taggedUnion("kind", [
  ActivityResultSuccess,
  ActivityResultFailure
]);
export type ActivityResult = t.TypeOf<typeof ActivityResult>;

// type alias for fetch, delete and backup of data
type DataFailure = QueryFailure | BlobCreationFailure | DocumentDeleteFailure;

const logPrefix = `DeleteUserDataActivity`;

const debug = (l: string) => <T>(e: T) => {
  if (process.env.DEBUG) {
    // tslint:disable-next-line: no-console
    console.log(`${logPrefix}:${l}`, e);
  }
  return e;
};

/**
 * Converts a Promise<Either> into a TaskEither
 * This is needed because our models return unconvenient type. Both left and rejection cases are handled as a TaskEither left
 * @param lazyPromise a lazy promise to convert
 * @param queryName an optional name for the query, for logging purpose
 *
 * @returns either the query result or a query failure
 */
const fromQueryEither = <R>(
  lazyPromise: () => Promise<Either<QueryError | Error, R>>
): TaskEither<Error, R> =>
  tryCatch(lazyPromise, toError).chain(errorOrResult =>
    fromEither(errorOrResult).mapLeft((err: QueryError | Error) =>
      err instanceof Error
        ? err
        : new Error(`QueryError: ${JSON.stringify(err)}`)
    )
  );

/**
 * To be used for exhaustive checks
 */
function assertNever(_: never): void {
  throw new Error("should not have executed this");
}

/**
 * to cast an error to QueryFailure
 * @param err
 */
const toQueryFailure = (err: Error | QueryError): QueryFailure =>
  QueryFailure.encode({
    kind: "QUERY_FAILURE",
    reason:
      err instanceof Error ? err.message : `QueryError: ${JSON.stringify(err)}`
  });

/**
 * to cast an error to a DocumentDeleteFailure
 * @param err
 */
const toDocumentDeleteFailure = (err: Error): DocumentDeleteFailure =>
  DocumentDeleteFailure.encode({
    kind: "DELETE_FAILURE",
    reason: err.message
  });

/**
 * Logs depending on failure type
 * @param context the Azure functions context
 * @param failure the failure to log
 */
const logFailure = (context: Context) => (
  failure: ActivityResultFailure
): void => {
  switch (failure.kind) {
    case "INVALID_INPUT_FAILURE":
      context.log.error(
        `${logPrefix}|Error decoding input|ERROR=${failure.reason}`
      );
      break;
    case "QUERY_FAILURE":
      context.log.error(
        `${logPrefix}|Error ${failure.query} query error|ERROR=${failure.reason}`
      );
      break;
    case "BLOB_FAILURE":
      context.log.error(
        `${logPrefix}|Error saving blob|ERROR=${failure.reason}`
      );
      break;
    case "USER_NOT_FOUND_FAILURE":
      context.log.error(`${logPrefix}|Error user not found|ERROR=`);
      break;
    case "DELETE_FAILURE":
      context.log.error(
        `${logPrefix}|Error deleting data|ERROR=${failure.reason}`
      );
      break;
    default:
      assertNever(failure);
  }
};

// define a value object with the info related to the blob storage for backup files
interface IBlobServiceInfo {
  blobService: BlobService;
  containerName: string;
  folder?: NonEmptyString;
}

/**
 * Saves data into a dedicated blob
 * @param blobServiceInfo references about where to save data
 * @param blobName name of the blob to be saved. It might not include a folder if specified in blobServiceInfo
 * @param data serializable data to be saved
 *
 * @returns either a blob failure or the saved object
 */
export const saveDataToBlob = <T>(
  { blobService, containerName, folder }: IBlobServiceInfo,
  blobName: string,
  data: T
): TaskEither<BlobCreationFailure, T> => {
  return taskify<Error, unknown>(cb =>
    blobService.createBlockBlobFromText(
      containerName,
      `${folder}${folder ? "/" : ""}${blobName}`,
      JSON.stringify(data),
      cb
    )
  )().bimap(
    err =>
      BlobCreationFailure.encode({
        kind: "BLOB_FAILURE",
        reason: err.message
      }),
    _ => data
  );
};

/**
 * Recursively consumes an iterator and executes operations on every item
 * @param deleteSingle takes an item and delete it
 * @param userDataBackup references about where to save data
 * @param makeBackupBlobName takes an item and construct a name for the backup blob
 * @param iterator an iterator of every result from the db
 */
const executeRecursiveBackupAndDelete = <T>(
  deleteSingle: (item: T) => Promise<Either<QueryError, string>>,
  userDataBackup: IBlobServiceInfo,
  makeBackupBlobName: (item: T) => string,
  iterator: IResultIterator<T>
): TaskEither<
  // tslint:disable-next-line: use-type-alias
  DataFailure,
  readonly T[]
> => {
  return (
    tryCatch(iterator.executeNext, toError)
      // this is just type lifting
      .foldTaskEither<DataFailure, Option<readonly T[]>>(
        e => fromEither(left(toQueryFailure(e))),
        e => fromEither(e).mapLeft(toQueryFailure)
      )
      .bimap(
        debug("executeRecursiveBackupAndDelete executeNext result left"),
        debug("executeRecursiveBackupAndDelete executeNext result right")
      )
      .foldTaskEither<DataFailure, readonly T[]>(
        e => fromEither(left(e)),
        maybeResults =>
          maybeResults.fold(
            // if the iterator content is none, exit the recursion
            taskEither.of([]),
            items =>
              // executes backup&delete for this set of items
              array.sequence(taskEither)(
                items.map((item: T) =>
                  sequenceT(taskEitherSeq)<
                    DataFailure,
                    // tslint:disable-next-line: readonly-array
                    [
                      TaskEither<DataFailure, T>,
                      TaskEither<DataFailure, string>,
                      // tslint:disable-next-line: readonly-array
                      TaskEither<DataFailure, readonly T[]>
                    ]
                  >(
                    saveDataToBlob<T>(
                      userDataBackup,
                      makeBackupBlobName(item),
                      item
                    ),
                    fromQueryEither(() => deleteSingle(item)).mapLeft(
                      toDocumentDeleteFailure
                    ),
                    // recursive step
                    executeRecursiveBackupAndDelete<T>(
                      deleteSingle,
                      userDataBackup,
                      makeBackupBlobName,
                      iterator
                    )
                  )
                    // aggregates the results at the end of the recursion
                    .map(([_, __, nextResults]) => [item, ...nextResults])
                )
              )
          )
      )
  );
};

/**
 * Backup and delete every version of the profile
 *
 * @param param0.profileModel instance of ProfileModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.fiscalCode the identifier of the user
 */
const backupAndDeleteProfile = ({
  fiscalCode,
  profileModel,
  userDataBackup
}: {
  profileModel: ProfileModel;
  userDataBackup: IBlobServiceInfo;
  fiscalCode: FiscalCode;
}) => {
  return executeRecursiveBackupAndDelete<RetrievedProfile>(
    item => profileModel.deleteProfileVersion(item.fiscalCode, item.id),
    userDataBackup,
    item => `profile--${item.version}.json`,
    profileModel.findAllVersionsByModelId(fiscalCode)
  ).bimap(
    debug("backupAndDeleteProfile left"),
    debug("backupAndDeleteProfile right")
  );
};

/**
 * Backup and delete a given notification
 *
 * @param param0.notificationModel instance of NotificationModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.notification the notification
 */
const backupAndDeleteNotification = ({
  notificationModel,
  userDataBackup,
  notification
}: {
  notificationModel: NotificationModel;
  userDataBackup: IBlobServiceInfo;
  notification: RetrievedNotification;
}): TaskEither<DataFailure, RetrievedNotification> => {
  return sequenceT(taskEitherSeq)<
    DataFailure,
    // tslint:disable-next-line: readonly-array
    [
      TaskEither<DataFailure, RetrievedNotification>,
      TaskEither<DataFailure, string>
    ]
  >(
    saveDataToBlob<RetrievedNotification>(
      userDataBackup,
      `notification--${notification.id}.json`,
      notification
    ),
    fromQueryEither(() =>
      notificationModel.deleteNotification(
        notification.messageId,
        notification.id
      )
    ).mapLeft(toDocumentDeleteFailure)
  )
    .map(_ => notification)
    .bimap(
      debug("backupAndDeleteNotification left"),
      debug("backupAndDeleteNotification right")
    );
};

/**
 * Find all versions of a notification status, then backup and delete each document
 * @param param0.notificationStatusModel instance of NotificationStatusModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.notification parent notification
 *
 */
const backupAndDeleteNotificationStatus = ({
  notificationStatusModel,
  userDataBackup,
  notification
}: {
  notificationStatusModel: NotificationStatusModel;
  userDataBackup: IBlobServiceInfo;
  notification: RetrievedNotification;
}): TaskEither<DataFailure, readonly RetrievedNotificationStatus[]> => {
  debug("backupAndDeleteNotificationStatus input")(notification);
  return executeRecursiveBackupAndDelete<RetrievedNotificationStatus>(
    item =>
      notificationStatusModel.deleteNotificationStatusVersion(
        item.notificationId,
        item.id
      ),
    userDataBackup,
    item => `notification-status--${item.version}.json`,
    notificationStatusModel.findAllVersionsByNotificationId(notification.id)
  ).bimap(
    debug("backupAndDeleteNotificationStatus left"),
    debug("backupAndDeleteNotificationStatus right")
  );
};

/**
 * Backup and delete a given message
 *
 * @param param0.messageStatusModel instance of MessageStatusModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.message the message
 */
const backupAndDeleteMessage = ({
  messageModel,
  userDataBackup,
  message
}: {
  messageModel: MessageModel;
  userDataBackup: IBlobServiceInfo;
  message: RetrievedMessageWithoutContent;
}): TaskEither<DataFailure, RetrievedMessageWithoutContent> => {
  return sequenceT(taskEitherSeq)<
    DataFailure,
    // tslint:disable-next-line: readonly-array
    [
      TaskEither<DataFailure, RetrievedMessageWithoutContent>,
      TaskEither<DataFailure, string>
    ]
  >(
    saveDataToBlob<RetrievedMessageWithoutContent>(
      userDataBackup,
      `message--${message.id}.json`,
      message
    ),
    fromQueryEither(() =>
      messageModel.deleteMessage(message.fiscalCode, message.id)
    ).mapLeft(toDocumentDeleteFailure)
  )
    .map(_ => message)
    .bimap(
      debug("backupAndDeleteMessage left"),
      debug("backupAndDeleteMessage right")
    );
};

const backupAndDeleteMessageContent = ({
  messageContentBlobService,
  messageModel,
  userDataBackup,
  message
}: {
  messageContentBlobService: BlobService;
  messageModel: MessageModel;
  userDataBackup: IBlobServiceInfo;
  message: RetrievedMessageWithoutContent;
}): TaskEither<DataFailure, Option<MessageContent>> => {
  return fromQueryEither(() =>
    messageModel
      .getContentFromBlob(messageContentBlobService, message.id)
      .then(debug("backupAndDeleteMessageContent yes"))
      .catch(e => {
        debug("backupAndDeleteMessageContent 0")(e);
        throw e;
      })
  )
    .foldTaskEither<DataFailure, Option<MessageContent>>(
      _ => {
        // unfortunately, a document not found is threated like a query error
        return taskEither.of(none);
      },
      maybeContent =>
        maybeContent.fold(
          // no document found, no document to delete
          taskEither.of(none),
          content =>
            sequenceT(taskEitherSeq)<
              DataFailure,
              // tslint:disable-next-line: readonly-array
              [
                TaskEither<DataFailure, MessageContent>,
                TaskEither<DataFailure, true>
              ]
            >(
              saveDataToBlob(
                userDataBackup,
                `messagecontent--${message.id}.json`,
                content
              ),
              fromQueryEither(() =>
                messageModel.deleteContentFromBlob(
                  messageContentBlobService,
                  message.id
                )
              ).mapLeft(toDocumentDeleteFailure)
            ).map(_ => some(content))
        )
    )
    .bimap(
      debug("backupAndDeleteMessageContent left"),
      debug("backupAndDeleteMessageContent right")
    );
};

/**
 * Find all versions of a message status, then backup and delete each document
 * @param param0.messageStatusModel instance of MessageStatusModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.message parent message
 *
 */
const backupAndDeleteMessageStatus = ({
  messageStatusModel,
  userDataBackup,
  message
}: {
  messageStatusModel: MessageStatusModel;
  userDataBackup: IBlobServiceInfo;
  message: RetrievedMessageWithoutContent;
}): TaskEither<DataFailure, readonly RetrievedMessageStatus[]> => {
  return executeRecursiveBackupAndDelete<RetrievedMessageStatus>(
    item =>
      messageStatusModel.deleteMessageStatusVersion(item.messageId, item.id),
    userDataBackup,
    item => `message-status--${item.version}.json`,
    messageStatusModel.findAllVersionsByModelId(message.id)
  ).bimap(
    debug("backupAndDeleteMessageStatus left"),
    debug("backupAndDeleteMessageStatus right")
  );
};

/**
 * For a given message, search all its notifications and backup&delete each one including its own notification status
 * @param param0.messageModel instance of MessageModel
 * @param param0.messageStatusModel instance of MessageStatusModel
 * @param param0.NotificationModel instance of NotificationModel
 * @param param0.notificationStatusModel instance of NotificationStatusModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.fiscalCode identifier of the user
 */
const backupAndDeleteAllNotificationsData = ({
  message,
  notificationModel,
  notificationStatusModel,
  userDataBackup
}: {
  message: RetrievedMessageWithoutContent;
  notificationModel: NotificationModel;
  notificationStatusModel: NotificationStatusModel;
  userDataBackup: IBlobServiceInfo;
}) =>
  fromQueryEither<ReadonlyArray<RetrievedNotification>>(() =>
    iteratorToArray(notificationModel.findNotificationsForMessage(message.id))
  )
    .bimap(
      debug(
        `findNotificationsForMessage query result message=${message.id} left`
      ),
      debug(
        `findNotificationsForMessage query result message=${message.id} right`
      )
    )
    .mapLeft(toQueryFailure)
    .foldTaskEither(
      e => fromEither(left(e)),
      notifications =>
        array.sequence(taskEither)(
          notifications.map(notification =>
            sequenceT(taskEitherSeq)(
              backupAndDeleteNotificationStatus({
                notification,
                notificationStatusModel,
                userDataBackup
              }),
              backupAndDeleteNotification({
                notification,
                notificationModel,
                userDataBackup
              })
            )
          )
        )
    )
    .bimap(
      debug("backupAndDeleteAllNotificationsData left"),
      debug("backupAndDeleteAllNotificationsData right")
    );

/**
 * For a given user, search all its messages and backup&delete each one including its own child models (messagestatus, notifications, message content)
 * @param param0.messageContentBlobService instance of blob service where message contents are stored
 * @param param0.messageModel instance of MessageModel
 * @param param0.messageStatusModel instance of MessageStatusModel
 * @param param0.NotificationModel instance of NotificationModel
 * @param param0.notificationStatusModel instance of NotificationStatusModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.fiscalCode identifier of the user
 */
const backupAndDeleteAllMessagesData = ({
  messageContentBlobService,
  messageModel,
  messageStatusModel,
  notificationModel,
  notificationStatusModel,
  userDataBackup,
  fiscalCode
}: {
  messageContentBlobService: BlobService;
  messageModel: MessageModel;
  messageStatusModel: MessageStatusModel;
  notificationModel: NotificationModel;
  notificationStatusModel: NotificationStatusModel;
  userDataBackup: IBlobServiceInfo;
  fiscalCode: FiscalCode;
}) =>
  fromQueryEither<ReadonlyArray<RetrievedMessageWithContent>>(() =>
    iteratorToArray(messageModel.findMessages(fiscalCode))
  )
    .mapLeft(toQueryFailure)
    .foldTaskEither(
      e => fromEither(left(e)),
      messages => {
        return array.sequence(taskEither)(
          messages.map(message => {
            // cast needed because findMessages has a wrong signature
            // tslint:disable-next-line: no-any
            const retrievedMessage = (message as any) as RetrievedMessageWithoutContent;
            return sequenceT(taskEither)(
              backupAndDeleteMessageContent({
                message: retrievedMessage,
                messageContentBlobService,
                messageModel,
                userDataBackup
              }),
              backupAndDeleteMessageStatus({
                message: retrievedMessage,
                messageStatusModel,
                userDataBackup
              }),
              backupAndDeleteAllNotificationsData({
                message: retrievedMessage,
                notificationModel,
                notificationStatusModel,
                userDataBackup
              })
            ).chain(_ =>
              backupAndDeleteMessage({
                message: retrievedMessage,
                messageModel,
                userDataBackup
              })
            );
          })
        );
      }
    )
    .bimap(
      debug("backupAndDeleteAllMessagesData left"),
      debug("backupAndDeleteAllMessagesData right")
    );

/**
 * Explores the user data structures and deletes all documents and blobs. Before that saves a blob for every found document in a dedicated storage folder
 * Versioned models are backupped with a blob for each document version.
 * Deletions happen after and only if the respective document has been successfully backupped.
 * Backups and deletions of parent models happen after and only if every child model has been backupped and deleted successfully (example: Message and MessageStatus).
 * This is important because children are found from their parents and otherwise it would create dangling models in case of an error occur.
 *
 * @param param0.messageContentBlobService instance of blob service where message contents are stored
 * @param param0.messageModel instance of MessageModel
 * @param param0.messageStatusModel instance of MessageStatusModel
 * @param param0.NotificationModel instance of NotificationModel
 * @param param0.notificationStatusModel instance of NotificationStatusModel
 * @param param0.profileModel instance of ProfileModel
 * @param param0.userDataBackup information about the blob storage account to place backup into
 * @param param0.fiscalCode identifier of the user
 */
export const backupAndDeleteAllUserData = ({
  messageContentBlobService,
  messageModel,
  messageStatusModel,
  notificationModel,
  notificationStatusModel,
  profileModel,
  userDataBackup,
  fiscalCode
}: {
  messageContentBlobService: BlobService;
  messageModel: MessageModel;
  messageStatusModel: MessageStatusModel;
  notificationModel: NotificationModel;
  notificationStatusModel: NotificationStatusModel;
  profileModel: ProfileModel;
  userDataBackup: IBlobServiceInfo;
  fiscalCode: FiscalCode;
}) => {
  return backupAndDeleteAllMessagesData({
    fiscalCode,
    messageContentBlobService,
    messageModel,
    messageStatusModel,
    notificationModel,
    notificationStatusModel,
    userDataBackup
  }).chain(_ =>
    backupAndDeleteProfile({ profileModel, userDataBackup, fiscalCode })
  );
};
export interface IActivityHandlerInput {
  messageModel: MessageModel;
  messageStatusModel: MessageStatusModel;
  notificationModel: NotificationModel;
  notificationStatusModel: NotificationStatusModel;
  profileModel: ProfileModel;
  messageContentBlobService: BlobService;
  userDataBackupBlobService: BlobService;
  userDataBackupContainerName: NonEmptyString;
}

/**
 * Factory methods that builds an activity function
 */
export function createDeleteUserDataActivityHandler({
  messageContentBlobService,
  messageModel,
  messageStatusModel,
  notificationModel,
  notificationStatusModel,
  profileModel,
  userDataBackupBlobService,
  userDataBackupContainerName
}: IActivityHandlerInput): (
  context: Context,
  input: unknown
) => Promise<ActivityResult> {
  return (context: Context, input: unknown) =>
    // validtes the input
    fromEither(
      ActivityInput.decode(input).mapLeft<ActivityResultFailure>(
        (reason: t.Errors) =>
          InvalidInputFailure.encode({
            kind: "INVALID_INPUT_FAILURE",
            reason: readableReport(reason)
          })
      )
    )
      // then perform backup&delete on all user data
      .chain(({ fiscalCode, backupFolder }) =>
        backupAndDeleteAllUserData({
          fiscalCode,
          messageContentBlobService,
          messageModel,
          messageStatusModel,
          notificationModel,
          notificationStatusModel,
          profileModel,
          userDataBackup: {
            blobService: userDataBackupBlobService,
            containerName: userDataBackupContainerName,
            folder: backupFolder
          }
        })
      )
      .bimap(
        failure => {
          logFailure(context)(failure);
          return failure;
        },
        _ =>
          ActivityResultSuccess.encode({
            kind: "SUCCESS"
          })
      )
      .run()
      .then(debug("result"))
      // unfold the value from the either
      .then(e => e.value);
}