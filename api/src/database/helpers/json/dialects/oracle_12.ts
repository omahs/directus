import { Knex } from 'knex';
import { JsonFieldNode } from '../../../../types';
import { JsonHelperDefault } from './default';
import { getOperation } from '../../../../utils/apply-query';
import { applyJsonFilterQuery } from '../filters';
import { Item } from '@directus/shared/types';
import { generateCapitalAlias } from '../../../../utils/generate-alias';

/**
 * JSON support for OracleDB 12+
 */
export class JsonHelperOracle_12 extends JsonHelperDefault {
	preProcess(dbQuery: Knex.QueryBuilder, table: string): void {
		const selectQueries = this.nodes.filter(
			({ jsonPath, query }) =>
				jsonPath.indexOf('[*]') === -1 && jsonPath.indexOf('.*') === -1 && Object.keys(query).length === 0
		);
		const joinQueries = this.nodes.filter(
			({ jsonPath, query }) =>
				jsonPath.indexOf('[*]') > 0 || jsonPath.indexOf('.*') > 0 || Object.keys(query).length > 0
		);

		if (joinQueries.length > 0) {
			const primaryKey = this.schema.collections[table].primary;
			for (const node of joinQueries) {
				const alias = generateCapitalAlias();
				this.buildWithJson(dbQuery, node, table, alias);
				dbQuery.leftJoin(alias, `${table}.${primaryKey}`, `${alias}.${primaryKey}`);
			}
		}
		if (selectQueries.length > 0) {
			dbQuery.select(
				this.nodes.map((node) => {
					const query = this.knex.raw('?', [node.jsonPath]).toQuery();
					return this.knex.raw(`COALESCE(json_query(??.??, ${query}),json_value(??.??, ${query})) as ??`, [
						table,
						node.name,
						table,
						node.name,
						node.fieldKey,
					]);
				})
			);
		}
	}
	postProcess(items: Item[]): void {
		this.postProcessParseJSON(items);
	}
	private buildWithJson(
		dbQuery: Knex.QueryBuilder,
		node: JsonFieldNode,
		table: string,
		alias: string
	): Knex.QueryBuilder {
		const { jsonPath } = node;
		const queryParts = this.splitQuery(jsonPath);
		const primaryKey = this.schema.collections[table].primary;

		const {
			table: joinTable,
			field: jsonField,
			alias: jsonAlias,
			conditions,
		} = this.buildJsonTable(table, node, queryParts);

		const selectList = [this.knex.raw('??.?? as ??', [table, primaryKey, primaryKey]), jsonField];

		const fromList = [this.knex.raw('??', [table]), joinTable];

		const subQuery = this.knex.select(selectList).fromRaw(this.knex.raw(fromList.map((f) => f.toQuery()).join(',')));

		for (const { alias, operator, value } of conditions) {
			applyJsonFilterQuery(subQuery, alias, operator, value);
		}

		const selectJsonField = node.query?.filter
			? this.knex.raw("COALESCE(??.??, '[]') as ??", [alias, jsonAlias, node.fieldKey])
			: this.knex.raw('??.?? as ??', [alias, jsonAlias, node.fieldKey]);
		dbQuery.with(alias, subQuery.groupBy(this.knex.raw('??.??', [table, primaryKey]))).select(selectJsonField);

		return dbQuery;
	}
	private buildJsonTable(
		table: string,
		node: JsonFieldNode,
		parts: string[]
	): {
		table: Knex.Raw;
		field: Knex.Raw;
		alias: string;
		conditions: { alias: string; operator: string; value: string | number }[];
	} {
		const rootPath = this.knex.raw('?', [parts[0]]).toQuery(),
			tableAlias = generateCapitalAlias(),
			fieldAlias = generateCapitalAlias();
		const conditions = [];
		let filterColumns = '';
		if (node.query?.filter) {
			for (const [jsonPath, value] of Object.entries(node.query?.filter)) {
				const { operator: filterOperator, value: filterValue } = getOperation(jsonPath, value);
				const conditionPath = this.knex.raw('?', [jsonPath]).toQuery();
				const conditionAlias = generateCapitalAlias();
				filterColumns += this.knex
					.raw(`, ?? ${getFilterType(filterOperator)} PATH ${conditionPath}`, [conditionAlias])
					.toQuery();
				conditions.push({ jsonPath, operator: filterOperator, value: filterValue, alias: conditionAlias });
			}
		}
		if (parts.length > 2) {
			let nestedColumns = '';
			for (let i = 1; i < parts.length - 1; i++) {
				const fieldPath = this.knex.raw('?', [parts[i]]).toQuery();
				nestedColumns += `NESTED PATH ${fieldPath} COLUMNS (`;
			}
			const fieldPair = [generateCapitalAlias(), generateCapitalAlias()];
			const fieldPath = this.knex.raw('?', [parts[parts.length - 1]]).toQuery();
			nestedColumns += this.knex
				.raw(`?? PATH ${fieldPath}, ?? FORMAT JSON PATH ${fieldPath}${filterColumns}`, fieldPair)
				.toQuery();
			for (let i = 1; i < parts.length; i++) {
				nestedColumns += ')';
			}
			const subQuery = this.knex.raw(`json_table(??.??, ${rootPath} COLUMNS (${nestedColumns}) as ??`, [
				table,
				node.name,
				tableAlias,
			]);
			return {
				table: subQuery,
				alias: fieldAlias,
				field: this.knex.raw(
					`CASE WHEN json_arrayagg(??.??) = '[]' THEN json_arrayagg(??.?? FORMAT JSON) ELSE json_arrayagg(??.??) END as ??`,
					[tableAlias, fieldPair[0], tableAlias, fieldPair[1], tableAlias, fieldPair[0], fieldAlias]
				),
				conditions,
			};
		}
		// simplified
		const fieldPair = [generateCapitalAlias(), generateCapitalAlias()];
		const fieldPath = this.knex.raw('?', [parts[1]]).toQuery();
		const subQuery = this.knex.raw(
			`json_table(??.??, ${rootPath} COLUMNS (?? PATH ${fieldPath}, ?? FORMAT JSON PATH ${fieldPath}${filterColumns})) as ??`,
			[table, node.name, fieldPair[0], fieldPair[1], tableAlias]
		);
		return {
			table: subQuery,
			alias: fieldAlias,
			field: this.knex.raw(
				`CASE WHEN json_arrayagg(??.??) = '[]' THEN json_arrayagg(??.?? FORMAT JSON) ELSE json_arrayagg(??.??) END as ??`,
				[tableAlias, fieldPair[0], tableAlias, fieldPair[1], tableAlias, fieldPair[0], fieldAlias]
			),
			conditions,
		};
	}
	private splitQuery(jsonPath: string): string[] {
		const parts = jsonPath.split('[*]');
		// add wildcards back in
		for (let i = 0; i < parts.length - 1; i++) {
			parts[i] += '[*]';
		}
		// do the same for property wildcards but nested
		return parts
			.flatMap((p) => {
				const _parts = p.split('.*');
				for (let i = 0; i < _parts.length - 1; i++) {
					_parts[i] += '.*';
				}
				return _parts;
			})
			.map((q) => (q.startsWith('$') ? q : '$' + q));
	}
	filterQuery(collection: string, node: JsonFieldNode): Knex.Raw {
		const qp = this.knex.raw('?', [node.jsonPath]).toQuery();
		return this.knex.raw(`JSON_VALUE(??.??, ${qp})`, [collection, node.name]);
	}
}

function getFilterType(operator: string): 'VARCHAR2' | 'NUMBER' | '' {
	switch (operator) {
		case '_eq':
		case '_neq':
		case '_ieq':
		case '_nieq':
		case '_contains':
		case '_ncontains':
		case '_icontains':
		case '_nicontains':
		case '_starts_with':
		case '_nstarts_with':
		case '_istarts_with':
		case '_nistarts_with':
		case '_ends_with':
		case '_nends_with':
		case '_iends_with':
		case '_niends_with':
		case '_in':
		case '_nin':
			return 'VARCHAR2';
		case '_gt':
		case '_gte':
		case '_lt':
		case '_lte':
		case '_between':
		case '_nbetween':
			return 'NUMBER';
		default:
			return '';
	}
}
