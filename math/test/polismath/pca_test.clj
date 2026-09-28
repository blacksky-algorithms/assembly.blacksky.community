;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.pca-test
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.core.matrix :as m]
            [polismath.math.conversation :as conversation]
            [polismath.math.named-matrix :as nm]
            [polismath.math.pca :as pca]))


(defn- nested
  [vectors]
  (mapv #(into [] %) vectors))


(defn- projections
  [conv]
  (zipmap (nm/rownames (:rating-mat conv)) (nested (:proj conv))))


(deftest single-statement-pca-test
  (let [votes [[1] [-1]]
        general (pca/wrapped-pca [[1 0] [-1 1] [0 1]] 2)
        {:keys [center comps] :as result} (pca/wrapped-pca votes 2)]
    (testing "two participants, one statement"
      (testing "returns the requested number of components"
        (is (= [[1.0] [0.0]] (nested comps)))
        (is (= [0.0] (into [] center))))
      (testing "has the shapes of the general case"
        (is (= [2 1] (m/shape comps)))
        (is (= [1] (m/shape center)))
        (is (= (mapv class (:comps general)) (mapv class comps)))
        (is (= (class (:center general)) (class center))))
      (testing "projects participants by their vote"
        (is (= [[1.0 0.0] [-1.0 0.0]]
               (nested (pca/sparsity-aware-project-ptpts votes result)))))
      (testing "projects the statement"
        (is (= [[-1.0 0.0]]
               (nested (pca/pca-project-cmnts result))))))
    (testing "uneven votes, one participant passing"
      (let [votes [[1] [1] [0] [-1]]
            result (pca/wrapped-pca votes 2)]
        (is (= [0.0] (into [] (:center result))))
        (is (= [[1.0 0.0] [1.0 0.0] [0.0 0.0] [-1.0 0.0]]
               (nested (pca/sparsity-aware-project-ptpts votes result))))))
    (testing "one participant, one statement"
      (is (= [[1.0] [0.0]] (nested (:comps (pca/wrapped-pca [[-1]] 2))))))
    (testing "other component counts"
      (is (= [[1.0]] (nested (:comps (pca/wrapped-pca votes 1)))))
      (is (= [[1.0] [0.0] [0.0]] (nested (:comps (pca/wrapped-pca votes 3))))))))


(deftest single-statement-conv-update-test
  (let [conv (conversation/conv-update
               {:raw-rating-mat (nm/named-matrix)}
               [{:created 100 :pid :a :tid :x :vote 1}
                {:created 200 :pid :b :tid :x :vote -1}])]
    (testing "two participants, one statement"
      (is (= [[1.0] [0.0]] (nested (get-in conv [:pca :comps]))))
      (is (= {:a [1.0 0.0] :b [-1.0 0.0]} (projections conv)))
      (is (= [[-1.0] [0.0]] (nested (get-in conv [:pca :comment-projection]))))
      (is (= [1.0] (into [] (get-in conv [:pca :comment-extremity])))))
    (testing "a third participant arriving afterwards"
      (let [conv (conversation/conv-update
                   conv
                   [{:created 300 :pid :c :tid :x :vote 1}])]
        (is (= [[1.0] [0.0]] (nested (get-in conv [:pca :comps]))))
        (is (= {:a [1.0 0.0] :b [-1.0 0.0] :c [1.0 0.0]} (projections conv)))))))


(deftest single-statement-large-conv-update-test
  (let [large {:ptpt-cutoff 1}
        fresh {:raw-rating-mat (nm/named-matrix)}
        votes [{:created 100 :pid :a :tid :x :vote 1}
               {:created 200 :pid :b :tid :x :vote -1}]
        conv (conversation/conv-update fresh votes large)]
    (testing "two participants, one statement, past the participant cutoff"
      (is (= [[1.0] [0.0]] (nested (get-in conv [:pca :comps]))))
      (is (= {:a [1.0 0.0] :b [-1.0 0.0]} (projections conv)))
      (is (= [[-1.0] [0.0]] (nested (get-in conv [:pca :comment-projection]))))
      (is (= [1.0] (into [] (get-in conv [:pca :comment-extremity])))))
    (testing "past the participant cutoff after an update below it"
      (let [conv (conversation/conv-update
                   (conversation/conv-update fresh votes)
                   [{:created 300 :pid :c :tid :x :vote 1}]
                   large)]
        (is (= [0.0] (into [] (get-in conv [:pca :center]))))
        (is (= [[1.0] [0.0]] (nested (get-in conv [:pca :comps]))))
        (is (= {:a [1.0 0.0] :b [-1.0 0.0] :c [1.0 0.0]} (projections conv)))))
    (testing "a second statement arriving afterwards"
      (let [grown (conversation/conv-update
                    conv
                    [{:created 300 :pid :a :tid :y :vote -1}
                     {:created 400 :pid :b :tid :y :vote 1}]
                    large)
            {:keys [a b]} (projections grown)]
        (is (= [2 2] (m/shape (get-in grown [:pca :comps]))))
        (is (= [2 2] (m/shape (:proj grown))))
        (is (every? #(Double/isFinite %) (concat a b)))
        (is (not= [0.0 0.0] a))
        (is (= a (mapv - b)))))))
