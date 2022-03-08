import { BaseService } from "medusa-interfaces"
import { removeIndex } from "../utils/remove-index"

class ShopifyCollectionService extends BaseService {
  constructor(
    {
      manager,
      shopifyProductService,
      productCollectionService,
      productService,
      storeService,
      productRepository,
    },
    options
  ) {
    super()

    this.options = options

    /** @private @const {EntityManager} */
    this.manager_ = manager
    /** @private @const {ShopifyProductService} */
    this.productService_ = shopifyProductService
    /** @private @const {ProductCollectionService} */
    this.collectionService_ = productCollectionService
    /** @private @const {StoreService} */
    this.storeService_ = storeService
    /** @private @const {ProductService} */
    this.medusaProductService_ = productService

    /** @private @const {Product} */
    this.productRepository_ = productRepository
  }

  withTransaction(transactionManager) {
    if (!transactionManager) {
      return this
    }

    const cloned = new ShopifyCollectionService({
      manager: transactionManager,
      options: this.options,
      shopifyProductService: this.productService_,
      productCollectionService: this.collectionService_,
      storeService: this.storeService_,
      productService: this.medusaProductService_,
      productRepository: this.productRepository_,
    })

    cloned.transactionManager_ = transactionManager

    return cloned
  }

  /**
   *
   * @param {Object[]} collects
   * @param {Object[]} collections
   * @param {Object[]} products
   * @return {Promise}
   */
  async createCustomCollections(collects, collections, products) {
    if (!collections) {
      return Promise.resolve()
    }

    return this.atomicPhase_(async (manager) => {
      const normalizedCollections = collections.map((c) =>
        this.normalizeCustomCollection_(c)
      )

      const result = []

      for (const nc of normalizedCollections) {
        let collection = await this.collectionService_
          .retrieveByHandle(nc.handle)
          .catch((_) => undefined)

        if (!collection) {
          collection = await this.collectionService_
            .withTransaction(manager)
            .create(nc)
        }

        const productIdsToAdd = this.getProductsForCustomCollection(
          collection.metadata.sh_id,
          collects,
          products
        )

        if (productIdsToAdd) {
          await this.addProductsToCollection(collection.id, productIdsToAdd)
        }

        result.push(collection)
      }

      return result
    })
  }

  async createSmartCollections(collections, products) {
    if (!collections) {
      return Promise.resolve()
    }

    const productRepo = this.manager_.getCustomRepository(
      this.productRepository_
    )

    const ids = products.map((p) => p.id)
    const completeProducts = await productRepo.findWithRelations(
      ["variants", "tags", "type"],
      ids
    )

    const defaultCurrency = await this.storeService_
      .retrieve()
      .then((store) => {
        return store.default_currency_code
      })
      .catch((_) => undefined)

    return this.atomicPhase_(async (manager) => {
      const normalizedCollections = collections.map((c) =>
        this.normalizeSmartCollection_(c)
      )

      const result = []

      for (const nc of normalizedCollections) {
        let collection = await this.collectionService_
          .retrieveByHandle(nc.collection.handle)
          .catch((_) => undefined)

        if (!collection) {
          collection = await this.collectionService_
            .withTransaction(manager)
            .create(nc.collection)
        }

        const validProducts = this.getValidProducts_(
          nc.rules,
          completeProducts,
          nc.disjunctive,
          defaultCurrency
        )

        if (validProducts.length) {
          const productIds = validProducts.map((p) => p.id)
          await this.addProductsToCollection(collection.id, productIds)
        }

        result.push(collection)
      }

      return result
    })
  }

  async addProductsToCollection(collectionId, productIds) {
    return this.atomicPhase_(async (manager) => {
      const result = await this.collectionService_
        .withTransaction(manager)
        .addProducts(collectionId, productIds)

      return result
    })
  }

  getProductsForCustomCollection(shCollectionId, collects, products) {
    if (!collects || !products) {
      return null
    }

    const medusaProductIds = products.reduce((prev, curr) => {
      if (curr.metadata?.sh_id) {
        prev[curr.metadata.sh_id] = curr.id
      }

      return prev
    }, {})

    const productIds = collects.reduce((productIds, c) => {
      if (c.collection_id === shCollectionId) {
        productIds.push(`${c.product_id}`)
      }
      return productIds
    }, [])

    const productIdsToAdd = Object.keys(medusaProductIds).filter(
      (shopifyId) => {
        if (productIds.includes(shopifyId)) {
          const medusaId = medusaProductIds[shopifyId]
          delete medusaProductIds[shopifyId]
          return medusaId
        }
      }
    )

    // remove added products from the array
    for (const id of productIdsToAdd) {
      const productToRemove = products.find((p) => p.id === id)
      removeIndex(products, productToRemove)
    }

    return productIdsToAdd
  }

  getValidProducts_(rules, products, disjunctive, defaultCurrency) {
    const validProducts = []

    for (const product of products) {
      const results = rules.map((r) =>
        this.testRule_(r, product, defaultCurrency)
      )

      if (disjunctive) {
        if (results.includes(false)) {
          continue
        }

        validProducts.push(product)
        removeIndex(products, product)
        continue
      }

      if (results.includes(true)) {
        validProducts.push(product)
        removeIndex(products, product)
        continue
      }

      continue
    }

    return validProducts
  }

  testRule_(rule, product, defaultCurrency = undefined) {
    const { column, relation, condition } = rule

    if (column === "title") {
      return this.testTextRelation_(product.title, relation, condition)
    }

    if (column === "type") {
      return this.testTextRelation_(product.type.value, relation, condition)
    }

    if (column === "vendor") {
      if (product.metadata?.vendor) {
        return this.testTextRelation_(
          product.metadata?.vendor,
          relation,
          condition
        )
      }

      return false
    }

    if (column === "variant_title") {
      if (product.variants?.length) {
        const anyMatch = product.variants.some((variant) => {
          return this.testTextRelation_(variant.title, relation, condition)
        })

        return anyMatch
      }

      return false
    }

    if (column === "tag") {
      console.warn("IN TAG CHECK", product.tags, relation, condition)
      if (product.tags) {
        const anyMatch = product.tags.some((tag) => {
          return this.testTextRelation_(tag.value, relation, condition)
        })

        return anyMatch
      }

      return false
    }

    if (column === "variant_inventory") {
      if (product.variants?.length) {
        const anyMatch = product.variants.some((variant) => {
          return this.testNumberRelation_(
            variant.inventory_quantity,
            relation,
            condition
          )
        })

        return anyMatch
      }

      return false
    }

    if (column === "variant_price") {
      if (product.variants?.length && defaultCurrency) {
        const prices = product.variants
          .map((variant) => {
            return variant.prices.filter(
              (p) => p.currency_code === defaultCurrency
            )
          })
          .flat()

        const anyMatch = prices.some((price) => {
          return this.testNumberRelation_(price.amount, relation, condition)
        })

        return anyMatch
      }

      return false
    }

    if (column === "variant_weight") {
      if (product.variants?.length) {
        const anyMatch = product.variants.some((variant) => {
          return this.testNumberRelation_(variant.weight, relation, condition)
        })

        return anyMatch
      }

      return false
    }

    // If we get here, it means the column is variant_compare_at_price which we don't support until we extend MoneyAmount
    return false
  }

  testTextRelation_(text, relation, condition) {
    if (relation === "contains") {
      return text.includes(condition)
    }

    if (relation === "equals") {
      return text === condition
    }

    if (relation === "not_equals") {
      return text !== condition
    }

    if (relation === "starts_with") {
      return text.startsWith(condition)
    }

    if (relation === "ends_with") {
      return text.endsWith(condition)
    }

    return false
  }

  testNumberRelation_(number, relation, condition) {
    if (relation === "greater_than") {
      return number > condition
    }

    if (relation === "less_than") {
      return number < condition
    }

    if (relation === "equals") {
      return number === condition
    }

    if (relation === "not_equals") {
      return number !== condition
    }

    return false
  }

  normalizeCustomCollection_(shopifyCollection) {
    return {
      title: shopifyCollection.title,
      handle: shopifyCollection.handle,
      metadata: {
        sh_id: shopifyCollection.id,
        sh_body: shopifyCollection.body_html,
      },
    }
  }

  normalizeSmartCollection_(smartCollection) {
    return {
      collection: {
        title: smartCollection.title,
        handle: smartCollection.handle,
        metadata: {
          sh_id: smartCollection.id,
          sh_body: smartCollection.body_html,
        },
      },
      rules: smartCollection.rules,
      disjunctive: smartCollection.disjunctive,
    }
  }
}

export default ShopifyCollectionService
