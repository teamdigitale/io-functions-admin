import { ServiceResponse, TableService } from "azure-storage";

import { Either, left, right } from "fp-ts/lib/Either";
import { none, Option, some } from "fp-ts/lib/Option";

import { ITuple2, Tuple2 } from "italia-ts-commons/lib/tuples";

/**
 * A promisified version of TableService.createTableIfNotExists
 */
export const createTableIfNotExists = (
  tableService: TableService,
  table: string
): Promise<Either<Error, TableService.TableResult>> =>
  new Promise(resolve =>
    tableService.createTableIfNotExists(table, (error, result, response) =>
      resolve(response.isSuccessful ? right(result) : left(error))
    )
  );

/**
 * A promisified version of TableService.insertEntity
 */
export const insertTableEntity = (
  tableService: TableService,
  table: string
) => <T>(
  entityDescriptor: T
): Promise<
  ITuple2<Either<Error, T | TableService.EntityMetadata>, ServiceResponse>
> =>
  new Promise(resolve =>
    tableService.insertEntity(
      table,
      entityDescriptor,
      (
        error: Error,
        result: T | TableService.EntityMetadata,
        response: ServiceResponse
      ) =>
        resolve(
          response.isSuccessful
            ? Tuple2(right(result), response)
            : Tuple2(left(error), response)
        )
    )
  );

export type InsertTableEntity = ReturnType<typeof insertTableEntity>;

/**
 * A promisified version of TableService.deleteEntity
 */
export const deleteTableEntity = (
  tableService: TableService,
  table: string
) => <T>(
  entityDescriptor: T
): Promise<ITuple2<Option<Error>, ServiceResponse>> =>
  new Promise(resolve =>
    tableService.deleteEntity(
      table,
      entityDescriptor,
      (error: Error, response: ServiceResponse) =>
        resolve(
          response.isSuccessful
            ? Tuple2(none, response)
            : Tuple2(some(error), response)
        )
    )
  );

export type DeleteTableEntity = ReturnType<typeof deleteTableEntity>;
